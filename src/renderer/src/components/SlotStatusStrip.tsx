/**
 * Slot status strip — one pip per slot per slot-mode repo.
 *
 * Pulled from the live repos list so multi-repo installs see every
 * pool side-by-side, separated by a small gap between repos. Each
 * pip is labelled `<first-letter-of-prefix><slot-id>` (uppercased) —
 * so a repo with prefix `ops` slot count 4 renders `O1 O2 O3 O4`;
 * the legacy `slot` prefix renders `S1 S2 …`.
 *
 * Color rules:
 *   - occupied → filled in the repo's accent color; click to focus
 *   - empty    → medium gray (intentionally above `--bg-3` so the
 *                pip stands out against the panel background)
 *
 * Ephemeral repos have no slots and aren't represented in the strip.
 */
import { useEffect, useState } from 'react';
import type { RepoRecord } from '@shared/persistence';
import { Tooltip } from './Tooltip';
import { colAccentStyle } from '../lib/repoColor';
import { useTranslation } from '../lib/i18n';

interface SlotStatusStripProps {
  /** Bumped externally when chats open/close so the strip refreshes
   *  without needing its own subscription to the agent event stream. */
  version: number;
  onClickOccupant?: (chatId: string) => void;
  /** Open Preferences (Repositories section) for first-time setup. */
  onSetupSlots?: () => void;
}

interface RepoSlotState {
  repo: RepoRecord;
  occupants: Map<number, { chatId: string; chatName: string; branch: string | null }>;
}

export function SlotStatusStrip({ version, onClickOccupant, onSetupSlots }: SlotStatusStripProps): JSX.Element | null {
  const { t } = useTranslation();
  const [data, setData] = useState<RepoSlotState[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repos = await window.popbot.repos.list();
      const slotRepos = repos.filter((r) => r.mode === 'slots');
      const occupancyByRepo = await Promise.all(
        slotRepos.map(async (r) => {
          const occs = await window.popbot.repos.listSlotOccupants(r.id);
          const map = new Map<number, { chatId: string; chatName: string; branch: string | null }>();
          for (const o of occs) {
            // `repos:listSlotOccupants` returns only `{slotId, chatName}`
            // today — pull the full record from `listSlotOccupantsForRepo`
            // shape if we want branch in the tooltip later. For now the
            // chatName + branch-less tooltip is enough.
            map.set(o.slotId, { chatId: '', chatName: o.chatName, branch: null });
          }
          return { repo: r, occupants: map };
        }),
      );
      // Re-enrich occupant chat ids — the public `listSlotOccupants`
      // doesn't include them, so cross-reference against the open
      // chats list (which the renderer already has via App, but we
      // can pull cheaply here too).
      const openChats = await window.popbot.chats.list();
      for (const block of occupancyByRepo) {
        for (const chat of openChats) {
          if (chat.repoId !== block.repo.id) continue;
          if (chat.slotId == null) continue;
          const existing = block.occupants.get(chat.slotId);
          if (existing) existing.chatId = chat.id;
        }
      }
      if (!cancelled) setData(occupancyByRepo);
    })();
    return () => { cancelled = true; };
  }, [version]);

  if (!data) return null;

  // No slot-mode repos OR all of them have zero slots → offer the
  // setup affordance (or render nothing if the host didn't wire one).
  const totalSlots = data.reduce((n, b) => n + b.repo.slotCount, 0);
  if (totalSlots === 0) {
    if (!onSetupSlots) return null;
    return (
      <div className="slot-strip">
        <button className="slot-setup-btn" onClick={onSetupSlots}>
          <i className="fa-solid fa-microchip" /> {t('slots.strip.setupBtn')}
        </button>
      </div>
    );
  }

  return (
    <div className="slot-strip">
      {data.map((block, blockIdx) => {
        const accent = colAccentStyle(block.repo.color);
        // First letter of the prefix, uppercased — keeps the pip
        // narrow even when the prefix is long (`popbot` → `P3`).
        const letter = (block.repo.slotPrefix[0] ?? 'S').toUpperCase();
        const slots: number[] = [];
        for (let i = 1; i <= block.repo.slotCount; i++) slots.push(i);
        return (
          <div
            key={block.repo.id}
            className="slot-strip-group"
            // Inline the col-accent on the group wrapper so the
            // occupied .slot-pip rule picks up the repo color via
            // CSS inheritance without each pip having to set it.
            style={accent}
            data-first-group={blockIdx === 0 || undefined}
          >
            {slots.map((slotId) => {
              const occ = block.occupants.get(slotId);
              const occupied = occ != null;
              const tip = (
                <div className="tip-slot">
                  <div className="tip-slot-head">
                    <span className="mono">{block.repo.slotPrefix}-{slotId}</span>
                    <span className="tip-slot-repo"> · {block.repo.id}</span>
                  </div>
                  {occupied
                    ? <div className="tip-slot-chat">{occ.chatName}</div>
                    : <div className="tip-slot-state">{t('slots.strip.free')}</div>}
                </div>
              );
              return (
                <Tooltip key={slotId} content={tip}>
                  <button
                    type="button"
                    className={`slot-pip ${occupied ? 'occupied' : 'empty'}`}
                    onClick={() => occupied && occ.chatId && onClickOccupant?.(occ.chatId)}
                    disabled={!occupied}
                    aria-label={occupied
                      ? t('slots.strip.occupiedAria', { repo: block.repo.id, slotId, chatName: occ.chatName })
                      : t('slots.strip.freeAria', { repo: block.repo.id, slotId })}
                  >{letter}{slotId}</button>
                </Tooltip>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
