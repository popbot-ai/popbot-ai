/**
 * Every host runs its Claude chats and bots on the desktop's active Claude
 * account (claudeAccounts.ts). The accounts go to each host at launch,
 * whenever they change, and again every PUSH_EVERY_MS — a host keeps them
 * only in memory, so one that restarted gets them back within minutes;
 * until then it uses its own CLAUDE_CODE_OAUTH_TOKEN, if set. The host
 * acts only when what it holds actually changes.
 */
import { listHosts } from '../persistence/hosts';
import { dlog } from '../diagLog';
import { hostRequest, HostRequestError } from './hostClient';
import { adoptExhaustedClaudeAccounts, claudeAccountSecrets, onClaudeAccountsChange } from './claudeAccounts';
import { exhaustedAccounts } from './claudeAuth';

const PUSH_EVERY_MS = 2 * 60_000;
/** Each host's last outcome, so the log notes only changes. */
const lastOutcome = new Map<string, string>();
/** Hosts (by id) that answered the last push with "no such thing": a
 *  popbot-host from before accounts, whose chats stay on that computer's
 *  own sign-in until it is updated. A host that did not answer at all is
 *  not one of these — being off is ordinary, and it gets the accounts
 *  when it is back. */
const outdated = new Set<string>();
const outdatedListeners = new Set<() => void>();

function setOutdated(hostId: string, is: boolean): void {
  if (outdated.has(hostId) === is) return;
  if (is) outdated.add(hostId);
  else outdated.delete(hostId);
  for (const l of outdatedListeners) {
    try { l(); } catch { /* a listener's bug must not stop the others */ }
  }
}

/** The names of the hosts too old to take accounts, as of the last push. */
export function claudeAccountsOutdatedHosts(): string[] {
  if (outdated.size === 0) return [];
  return listHosts().filter((h) => outdated.has(h.id)).map((h) => h.name);
}

export function onClaudeAccountsOutdatedHostsChange(listener: () => void): () => void {
  outdatedListeners.add(listener);
  return () => outdatedListeners.delete(listener);
}

/** Send the accounts to every host now (and learn what each knows is out
 *  of usage). Exported so a failover can wait for the hosts to have the
 *  new account before it replays a host chat's turn. */
export async function pushClaudeAccountsNow(): Promise<void> {
  return pushAll();
}

async function pushAll(): Promise<void> {
  const body = { ...claudeAccountSecrets(), exhausted: exhaustedAccounts() };
  const hosts = listHosts();
  await Promise.all(hosts.map(async (host) => {
    let outcome: string;
    let tooOld = false;
    try {
      const res = await hostRequest<{ ok: boolean; changed?: boolean; exhausted?: Record<string, number> }>(host, 'POST', '/v1/claude-accounts', body, 15_000);
      outcome = 'ok';
      // A host that failed over while this desktop was away knows better.
      adoptExhaustedClaudeAccounts(res.exhausted);
      if (res.changed) dlog('claude.accounts.pushed', { host: host.name, accounts: body.accounts.length, active: body.activeId });
    } catch (err) {
      outcome = err instanceof Error ? err.message : String(err);
      // It answered, and has no such route: a host from before accounts.
      tooOld = err instanceof HostRequestError && err.status === 404;
    }
    setOutdated(host.id, tooOld);
    if (lastOutcome.get(host.id) !== outcome) {
      if (outcome !== 'ok') dlog('claude.accounts.push-failed', { host: host.name, error: outcome });
      lastOutcome.set(host.id, outcome);
    }
  }));
  // A host removed since is nobody's to update.
  for (const id of outdated) {
    if (!hosts.some((h) => h.id === id)) setOutdated(id, false);
  }
}

let started = false;

export function startClaudeAccountsSync(): void {
  if (started) return;
  started = true;
  setTimeout(() => void pushAll(), 5_000).unref?.();
  setInterval(() => void pushAll(), PUSH_EVERY_MS).unref?.();
  onClaudeAccountsChange(() => void pushAll());
}
