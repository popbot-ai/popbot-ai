/**
 * Every host runs its Codex chats on the desktop's active Codex account
 * (codexAccounts.ts). What goes to a host is each account's ACCESS token
 * — good for about ten days — never the sign-in itself: a sign-in that
 * two computers both renewed would be refused on one of them. The
 * desktop renews, and sends the newer token along.
 *
 * As for Claude accounts (claudeAccountsSync.ts): at launch, whenever
 * the accounts change, and again every PUSH_EVERY_MS — a host keeps them
 * only in memory, so one that restarted gets them back within minutes;
 * until then its Codex chats use that computer's own Codex sign-in.
 */
import { listHosts } from '../persistence/hosts';
import { dlog } from '../diagLog';
import { hostRequest, HostRequestError } from './hostClient';
import { adoptExhaustedCodexAccounts, codexAccountSecrets, onCodexAccountsChange } from './codexAccounts';
import { exhaustedCodexAccounts } from './codexAuth';

const PUSH_EVERY_MS = 2 * 60_000;
/** Each host's last outcome, so the log notes only changes. */
const lastOutcome = new Map<string, string>();
/** Hosts (by id) that answered the last push with "no such thing": a
 *  popbot-host from before Codex accounts, whose Codex chats stay on that
 *  computer's own sign-in until it is updated. */
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

/** The names of the hosts too old to take Codex accounts, as of the last
 *  push — only worth saying while there are accounts to send. */
export function codexAccountsOutdatedHosts(): string[] {
  if (outdated.size === 0) return [];
  return listHosts().filter((h) => outdated.has(h.id)).map((h) => h.name);
}

export function onCodexAccountsOutdatedHostsChange(listener: () => void): () => void {
  outdatedListeners.add(listener);
  return () => outdatedListeners.delete(listener);
}

/** Send the accounts to every host now (and learn what each knows is out
 *  of usage). Exported so a failover can wait for the hosts to have the
 *  new account before it replays a host chat's turn. */
export async function pushCodexAccountsNow(): Promise<void> {
  return pushAll();
}

/** Whether a host has ever been sent accounts: one that never had any is
 *  not told "none" every two minutes. */
let everSent = false;

async function pushAll(): Promise<void> {
  const secrets = codexAccountSecrets();
  if (secrets.accounts.length === 0 && !everSent) return;
  everSent = true;
  const body = { ...secrets, exhausted: exhaustedCodexAccounts() };
  const hosts = listHosts();
  await Promise.all(hosts.map(async (host) => {
    let outcome: string;
    let tooOld = false;
    try {
      const res = await hostRequest<{ ok: boolean; changed?: boolean; exhausted?: Record<string, number> }>(host, 'POST', '/v1/codex-accounts', body, 15_000);
      outcome = 'ok';
      // A host that failed over while this desktop was away knows better.
      adoptExhaustedCodexAccounts(res.exhausted);
      if (res.changed) dlog('codex.accounts.pushed', { host: host.name, accounts: body.accounts.length, active: body.activeId });
    } catch (err) {
      outcome = err instanceof Error ? err.message : String(err);
      // It answered, and has no such route: a host from before Codex accounts.
      tooOld = err instanceof HostRequestError && err.status === 404;
    }
    setOutdated(host.id, tooOld);
    if (lastOutcome.get(host.id) !== outcome) {
      if (outcome !== 'ok') dlog('codex.accounts.push-failed', { host: host.name, error: outcome });
      lastOutcome.set(host.id, outcome);
    }
  }));
  // A host removed since is nobody's to update.
  for (const id of outdated) {
    if (!hosts.some((h) => h.id === id)) setOutdated(id, false);
  }
}

let started = false;

export function startCodexAccountsSync(): void {
  if (started) return;
  started = true;
  setTimeout(() => void pushAll(), 6_000).unref?.();
  setInterval(() => void pushAll(), PUSH_EVERY_MS).unref?.();
  onCodexAccountsChange(() => void pushAll());
}
