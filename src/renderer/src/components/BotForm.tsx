/**
 * Make or change a bot: its host, name and prompt, the repository and
 * GitHub account it works as, and the triggers that wake it — a list of
 * frames, each with its fields and an example of what it sends the bot.
 *
 * A new bot is made with one button (half a bot is no bot). An existing
 * one applies each change when the field is left, with a verdict inline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotHostListing } from '@shared/ipc';
import type { BotTrigger, HostBotInfo, HostBotInput } from '@shared/hostProtocol';
import { DEFAULT_GITHUB_POLL_SECONDS } from '@shared/hostProtocol';
import { BOT_TEMPLATES } from '@shared/botTemplates';
import { exampleWakeText } from '@shared/botTriggers';
import { useTranslation } from '../lib/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { IconSelect } from './IconSelect';

interface BotFormProps {
  hosts: BotHostListing[];
  /** The bot to change; absent to make one. */
  editing?: { hostId: string; bot: HostBotInfo };
  onClose: () => void;
  /** After a bot was made or changed. */
  onSaved: () => void;
}

type Verdict = { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; text: string } | null;

/** The picture as a small square thumbnail: centre-cropped and scaled
 *  to THUMB px, so it stays small in the host's config and listings. */
const THUMB = 128;
function thumbnail(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = THUMB;
      canvas.height = THUMB;
      const ctx = canvas.getContext('2d');
      if (!ctx || !side) return reject(new Error('that image could not be read'));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, THUMB, THUMB);
      const png = canvas.toDataURL('image/png');
      // A photo compresses far better as JPEG.
      resolve(png.length > 60_000 ? canvas.toDataURL('image/jpeg', 0.88) : png);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('that file is not an image'));
    };
    img.src = url;
  });
}

/** A comma-separated list that keeps what is typed — a trailing comma,
 *  spaces — while handing the parsed list up as it changes. */
function ListField({ value, placeholder, onChange, onCommit }: {
  value: string[];
  placeholder: string;
  onChange: (list: string[]) => void;
  onCommit: () => void;
}): JSX.Element {
  const parse = (text: string): string[] => text.split(',').map((p) => p.trim()).filter(Boolean);
  const [text, setText] = useState(value.join(', '));
  // A change from outside (not this field's typing) replaces the text.
  const joined = value.join('\u0000');
  useEffect(() => {
    if (parse(text).join('\u0000') !== joined) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (
    <input
      className="input"
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)); }}
      onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === 'Enter') onCommit(); }}
    />
  );
}

/** The talks-to list as typed: names or ids, separated by commas. */
function parsePeers(text: string): string[] {
  return [...new Set(text.split(',').map((p) => p.trim()).filter(Boolean))];
}

let triggerSeq = 0;
function newTriggerId(): string {
  triggerSeq += 1;
  return `t${Date.now().toString(36)}${triggerSeq}`;
}

export function BotForm({ hosts, editing, onClose, onSaved }: BotFormProps): JSX.Element {
  const { t } = useTranslation();
  const reachable = hosts.filter((h) => h.reachable);
  const [hostId, setHostId] = useState(editing?.hostId ?? reachable[0]?.hostId ?? '');
  const [name, setName] = useState(editing?.bot.name ?? '');
  const [prompt, setPrompt] = useState(editing?.bot.prompt ?? '');
  const [repoId, setRepoId] = useState(editing?.bot.repoId ?? '');
  const [githubLogin, setGithubLogin] = useState(editing?.bot.githubLogin ?? '');
  const [email, setEmail] = useState(editing?.bot.email ?? '');
  const [avatar, setAvatar] = useState<string | null>(editing?.bot.avatar ?? null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [githubToken, setGithubToken] = useState('');
  // A host from before teams sends GitHub triggers without one.
  const [triggers, setTriggers] = useState<BotTrigger[]>(
    () => (editing?.bot.triggers ?? []).map((tr) => (tr.kind === 'github' ? { ...tr, team: tr.team ?? '' } : tr)),
  );
  const [peersText, setPeersText] = useState((editing?.bot.peers ?? []).join(', '));
  const [addOpen, setAddOpen] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const listEnd = useRef<HTMLDivElement | null>(null);

  const host = hosts.find((h) => h.hostId === hostId) ?? null;
  /** The other bots on its host it could talk to. */
  const others = (host?.bots ?? []).filter((b) => b.id !== editing?.bot.id);
  const fallbackRepo = useMemo(() => (repoId ? `(${repoId}'s GitHub repository)` : null), [repoId]);

  useEffect(() => {
    if (!addOpen) return;
    const close = (): void => setAddOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [addOpen]);

  const input = (patch: Partial<HostBotInput> = {}): HostBotInput => ({
    name: name.trim(),
    prompt,
    repoId: repoId || null,
    githubLogin: githubLogin.trim() || null,
    email: email.trim() || null,
    avatar,
    triggers,
    peers: parsePeers(peersText),
    ...(githubToken.trim() ? { githubToken: githubToken.trim() } : {}),
    ...patch,
  });

  /** An existing bot applies each change as it is made. */
  const apply = async (patch: Partial<HostBotInput> = {}): Promise<void> => {
    if (!editing) return;
    if (!(patch.name ?? name).trim()) return;
    setVerdict({ kind: 'saving' });
    const res = await window.popbot.bots.save(editing.hostId, editing.bot.id, input(patch));
    if (res.ok) {
      setVerdict({ kind: 'saved' });
      if (githubToken) setGithubToken('');
      onSaved();
    } else {
      setVerdict({ kind: 'error', text: res.error });
    }
  };

  const create = async (): Promise<void> => {
    if (!hostId || !name.trim()) return;
    setCreating(true);
    setVerdict(null);
    const res = await window.popbot.bots.save(hostId, null, input());
    setCreating(false);
    if (res.ok) {
      onSaved();
      onClose();
    } else {
      setVerdict({ kind: 'error', text: res.error });
    }
  };

  const setTrigger = (id: string, next: BotTrigger, applyNow = false): void => {
    const list = triggers.map((x) => (x.id === id ? next : x));
    setTriggers(list);
    if (applyNow) void apply({ triggers: list });
  };

  const removeTrigger = (id: string): void => {
    const list = triggers.filter((x) => x.id !== id);
    setTriggers(list);
    void apply({ triggers: list });
  };

  const addTrigger = (kind: BotTrigger['kind']): void => {
    const trigger: BotTrigger = kind === 'github'
      ? { id: newTriggerId(), kind: 'github', repo: null, labels: [], team: '', pollSeconds: DEFAULT_GITHUB_POLL_SECONDS }
      : { id: newTriggerId(), kind: 'cron', schedule: '0 9 * * 1-5', message: '' };
    setTriggers((prev) => [...prev, trigger]);
    setAddOpen(false);
    // A new GitHub trigger has no labels yet; it is applied once it does.
    setTimeout(() => listEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal bot-form" data-screen-label="Modal · bot">
        <div className="modal-head">
          <h2>{editing ? t('bots.form.editTitle', { name: editing.bot.name }) : t('bots.form.newTitle')}</h2>
          <span style={{ flex: 1 }} />
          {verdict && (
            <span className={`bot-form-verdict ${verdict.kind}`}>
              {verdict.kind === 'saving' ? t('common.saving') : verdict.kind === 'saved' ? t('common.saved') : verdict.text}
            </span>
          )}
          <button className="btn ghost sm" onClick={onClose} title={t('common.close')}>×</button>
        </div>
        <div className="modal-body bot-form-body">
          <div className="field">
            <label>{t('bots.form.host')}</label>
            {editing ? (
              <span className="bot-form-static">{host?.hostName ?? editing.hostId}</span>
            ) : (
              <IconSelect
                block
                value={hostId}
                placeholder={t('bots.form.noHosts')}
                onChange={(id) => { setHostId(id); setRepoId(''); }}
                options={hosts.map((h) => ({
                  id: h.hostId,
                  label: h.hostName,
                  icon: <i className={`fa-solid fa-server tracker-dd-ico-fa host-ico${h.reachable ? '' : ' off'}`} />,
                  ...(h.reachable ? {} : { detail: t('bots.hostOff'), disabled: true }),
                }))}
              />
            )}
          </div>
          <div className="field">
            <label>{t('bots.form.name')}</label>
            <input
              className="input"
              type="text"
              value={name}
              placeholder={t('bots.form.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void apply()}
              onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }}
            />
          </div>
          <div className="field">
            <label>{t('bots.form.picture')}</label>
            <div className="bot-form-avatar-row">
              <button className="bot-avatar lg" onClick={() => fileRef.current?.click()} title={t('bots.form.pictureUpload')}>
                {avatar ? <img src={avatar} alt="" /> : <i className="fa-solid fa-robot" />}
              </button>
              <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>{t('bots.form.pictureUpload')}</button>
              {avatar && (
                <button className="btn ghost sm" onClick={() => { setAvatar(null); void apply({ avatar: null }); }}>
                  {t('bots.form.pictureRemove')}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void thumbnail(file).then((url) => {
                    setAvatar(url);
                    void apply({ avatar: url });
                  }).catch((err: unknown) => setVerdict({ kind: 'error', text: err instanceof Error ? err.message : String(err) }));
                }}
              />
            </div>
          </div>
          <div className="field stack">
            <label>
              {t('bots.form.prompt')}
              <span className="bot-form-templates">
                {t('bots.form.startFrom')}
                {BOT_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    className="btn ghost sm"
                    onClick={() => {
                      if (prompt.trim()) {
                        setReplacing(tpl.prompt);
                        return;
                      }
                      setPrompt(tpl.prompt);
                      void apply({ prompt: tpl.prompt });
                    }}
                  >
                    {t(`bots.template.${tpl.id}`)}
                  </button>
                ))}
              </span>
            </label>
            <textarea
              className="input bot-form-prompt"
              value={prompt}
              placeholder={t('bots.form.promptPlaceholder')}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => void apply()}
            />
          </div>
          <div className="field">
            <label>{t('bots.form.repo')}</label>
            <IconSelect
              block
              value={repoId}
              onChange={(id) => { setRepoId(id); void apply({ repoId: id || null }); }}
              options={[
                { id: '', label: t('bots.form.noRepo'), icon: <i className="fa-regular fa-folder tracker-dd-ico-fa" /> },
                ...(host?.repos ?? []).map((r) => ({
                  id: r.id,
                  label: r.id,
                  icon: <i className="fa-solid fa-code-branch tracker-dd-ico-fa" />,
                  detail: r.defaultBase,
                })),
              ]}
            />
          </div>
          <div className="field">
            <label>{t('bots.form.githubLogin')}</label>
            <input
              className="input"
              type="text"
              value={githubLogin}
              placeholder={t('bots.form.githubLoginPlaceholder')}
              onChange={(e) => setGithubLogin(e.target.value)}
              onBlur={() => void apply()}
              onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }}
            />
          </div>
          <div className="field">
            <label>{t('bots.form.email')}</label>
            <input
              className="input"
              type="email"
              value={email}
              // Empty: the account's GitHub noreply address, which the host uses.
              placeholder={githubLogin.trim() ? `${githubLogin.trim().replace(/^@/, '')}@users.noreply.github.com` : t('bots.form.emailPlaceholder')}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => void apply()}
              onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }}
            />
          </div>
          <div className="field">
            <label>{t('bots.form.githubToken')}</label>
            <input
              className="input"
              type="password"
              value={githubToken}
              placeholder={editing?.bot.hasToken ? t('bots.form.tokenSet') : t('bots.form.tokenPlaceholder')}
              onChange={(e) => setGithubToken(e.target.value)}
              onBlur={() => { if (githubToken.trim()) void apply(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && githubToken.trim()) void apply(); }}
            />
          </div>

          <div className="field">
            <label>{t('bots.form.talksTo')}</label>
            <input
              className="input"
              type="text"
              value={peersText}
              placeholder={t('bots.form.talksToPlaceholder')}
              onChange={(e) => setPeersText(e.target.value)}
              onBlur={() => void apply({ peers: parsePeers(peersText) })}
              onKeyDown={(e) => { if (e.key === 'Enter') void apply({ peers: parsePeers(peersText) }); }}
            />
          </div>
          {others.length > 0 && (
            <div className="bot-form-peers">
              {others.map((b) => {
                const on = parsePeers(peersText).some((p) => p.toLowerCase() === b.id.toLowerCase() || p.toLowerCase() === b.name.toLowerCase());
                return (
                  <button
                    key={b.id}
                    className={`pill ${on ? 'run' : 'muted'} bot-form-peer`}
                    title={on ? t('bots.form.peerRemove') : t('bots.form.peerAdd')}
                    onClick={() => {
                      const current = parsePeers(peersText);
                      const next = on
                        ? current.filter((p) => p.toLowerCase() !== b.id.toLowerCase() && p.toLowerCase() !== b.name.toLowerCase())
                        : [...current, b.id];
                      setPeersText(next.join(', '));
                      void apply({ peers: next });
                    }}
                  >
                    {on ? '✓ ' : '+ '}{b.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="bot-form-hint">{t('bots.form.talksToHint')}</div>

          <div className="bot-form-triggers-head">{t('bots.form.triggers')}</div>
          {triggers.length === 0 && <div className="bot-form-hint">{t('bots.form.noTriggers')}</div>}
          {triggers.map((trigger) => (
            <div className="bot-trigger" key={trigger.id}>
              <div className="bot-trigger-head">
                <i className={trigger.kind === 'github' ? 'fa-brands fa-github' : 'fa-regular fa-clock'} />
                <span>{trigger.kind === 'github' ? t('bots.trigger.github') : t('bots.trigger.cron')}</span>
                <span style={{ flex: 1 }} />
                <button className="bot-trigger-delete" title={t('bots.trigger.delete')} onClick={() => removeTrigger(trigger.id)}>
                  <i className="fa-regular fa-trash-can" />
                </button>
              </div>
              {trigger.kind === 'github' ? (
                <>
                  <div className="field">
                    <label>{t('bots.trigger.repo')}</label>
                    <input
                      className="input"
                      type="text"
                      value={trigger.repo ?? ''}
                      placeholder={repoId ? t('bots.trigger.repoFromBot') : 'owner/name'}
                      onChange={(e) => setTrigger(trigger.id, { ...trigger, repo: e.target.value || null })}
                      onBlur={() => void apply()}
                    />
                  </div>
                  <div className="field">
                    <label>{t('bots.trigger.labels')}</label>
                    <ListField
                      value={trigger.labels}
                      placeholder={t('bots.trigger.labelsPlaceholder')}
                      onChange={(labels) => setTrigger(trigger.id, { ...trigger, labels })}
                      onCommit={() => void apply()}
                    />
                  </div>
                  <div className="field">
                    <label>{t('bots.trigger.team')}</label>
                    <input
                      className="input"
                      type="text"
                      value={trigger.team}
                      placeholder={t('bots.trigger.teamPlaceholder')}
                      onChange={(e) => setTrigger(trigger.id, { ...trigger, team: e.target.value })}
                      onBlur={() => void apply()}
                      onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }}
                    />
                  </div>
                  <div className={`bot-form-hint indented${trigger.team.trim() ? '' : ' warn'}`}>
                    {trigger.team.trim()
                      ? trigger.team.split(',').some((p) => p.trim() === '*')
                        ? t('bots.trigger.teamAnyone')
                        : t('bots.trigger.teamHint')
                      : t('bots.trigger.teamBlank')}
                  </div>
                  <div className="field">
                    <label>{t('bots.trigger.every')}</label>
                    <div className="bot-trigger-inline">
                      <input
                        className="input"
                        type="number"
                        min={15}
                        value={trigger.pollSeconds}
                        onChange={(e) => setTrigger(trigger.id, { ...trigger, pollSeconds: Number(e.target.value) || DEFAULT_GITHUB_POLL_SECONDS })}
                        onBlur={() => void apply()}
                      />
                      <span>{t('bots.trigger.seconds')}</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>{t('bots.trigger.schedule')}</label>
                    <input
                      className="input"
                      type="text"
                      value={trigger.schedule}
                      placeholder="0 9 * * 1-5"
                      title={t('bots.trigger.scheduleHelp')}
                      onChange={(e) => setTrigger(trigger.id, { ...trigger, schedule: e.target.value })}
                      onBlur={() => void apply()}
                    />
                  </div>
                  <div className="field">
                    <label>{t('bots.trigger.message')}</label>
                    <input
                      className="input"
                      type="text"
                      value={trigger.message}
                      placeholder={t('bots.trigger.messagePlaceholder')}
                      onChange={(e) => setTrigger(trigger.id, { ...trigger, message: e.target.value })}
                      onBlur={() => void apply()}
                    />
                  </div>
                </>
              )}
              <div className="bot-trigger-sends">
                <div className="bot-trigger-sends-label">
                  {trigger.kind === 'github' ? t('bots.trigger.sendsGithub') : t('bots.trigger.sendsCron')}
                </div>
                <pre>{exampleWakeText(trigger, fallbackRepo)}</pre>
              </div>
            </div>
          ))}
          <div className="bot-trigger-add" ref={listEnd}>
            <button
              className="btn sm"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setAddOpen((v) => !v)}
            >
              <i className="fa-solid fa-plus" /> {t('bots.form.addTrigger')} <i className="fa-solid fa-caret-down" />
            </button>
            {addOpen && (
              <div className="git-context-menu bot-trigger-add-menu" onMouseDown={(e) => e.stopPropagation()}>
                <button className="git-menu-item" onClick={() => addTrigger('github')}>
                  <i className="fa-brands fa-github" /> {t('bots.trigger.github')}
                </button>
                <button className="git-menu-item" onClick={() => addTrigger('cron')}>
                  <i className="fa-regular fa-clock" /> {t('bots.trigger.cron')}
                </button>
              </div>
            )}
          </div>
        </div>
        {replacing !== null && (
          <ConfirmDialog
            title={t('bots.form.replaceTitle')}
            message={t('bots.form.replacePrompt')}
            confirmLabel={t('bots.form.replace')}
            destructive
            onCancel={() => setReplacing(null)}
            onConfirm={() => {
              const next = replacing;
              setReplacing(null);
              setPrompt(next);
              void apply({ prompt: next });
            }}
          />
        )}
        {!editing && (
          <div className="modal-foot">
            <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={creating || !hostId || !name.trim()} onClick={() => void create()}>
              {creating ? t('bots.form.creating') : t('bots.form.create')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
