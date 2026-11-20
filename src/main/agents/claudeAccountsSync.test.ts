import { beforeEach, describe, expect, it, vi } from 'vitest';

// The hosts PopBot knows, and what each answers to the accounts push.
const hosts: Array<{ id: string; name: string; url: string; token: string }> = [];
const answers: Record<string, () => unknown> = {};

vi.mock('../diagLog', () => ({ dlog: () => undefined }));
vi.mock('../persistence/hosts', () => ({ listHosts: () => hosts }));
vi.mock('./claudeAccounts', () => ({
  adoptExhaustedClaudeAccounts: () => undefined,
  claudeAccountSecrets: () => ({ activeId: null, accounts: [] }),
  onClaudeAccountsChange: () => () => undefined,
}));
vi.mock('./hostClient', async (original) => ({
  ...(await original<typeof import('./hostClient')>()),
  hostRequest: async (host: { name: string }) => answers[host.name](),
}));

const { HostRequestError } = await import('./hostClient');
const { claudeAccountsOutdatedHosts, onClaudeAccountsOutdatedHostsChange, pushClaudeAccountsNow } = await import('./claudeAccountsSync');

const tooOld = (name: string) => (): never => { throw new HostRequestError(404, `${name}: not found`); };
const off = (name: string) => (): never => { throw new HostRequestError(0, `${name}: fetch failed`); };
const fine = (): unknown => ({ ok: true });

describe('hosts too old to take accounts', () => {
  let news = 0;
  onClaudeAccountsOutdatedHostsChange(() => { news += 1; });

  beforeEach(async () => {
    hosts.splice(0, hosts.length,
      { id: 'h1', name: 'studio', url: 'http://studio', token: 't' },
      { id: 'h2', name: 'laptop', url: 'http://laptop', token: 't' });
    answers.studio = fine;
    answers.laptop = fine;
    await pushClaudeAccountsNow();
    news = 0;
  });

  it('names a host that answers but has no place for accounts', async () => {
    answers.studio = tooOld('studio');
    await pushClaudeAccountsNow();
    expect(claudeAccountsOutdatedHosts()).toEqual(['studio']);
    expect(news).toBe(1);
    // The same answer at the next push is not news.
    await pushClaudeAccountsNow();
    expect(news).toBe(1);
    // By its name as it is now.
    hosts[0].name = 'studio-mac';
    answers['studio-mac'] = tooOld('studio-mac');
    expect(claudeAccountsOutdatedHosts()).toEqual(['studio-mac']);
    // Updated: it takes the accounts, and is no longer named.
    answers['studio-mac'] = fine;
    await pushClaudeAccountsNow();
    expect(claudeAccountsOutdatedHosts()).toEqual([]);
    expect(news).toBe(2);
  });

  it('says nothing of a host that is off, or that refuses for another reason', async () => {
    answers.studio = off('studio');
    answers.laptop = () => { throw new HostRequestError(401, 'laptop: the token was refused'); };
    await pushClaudeAccountsNow();
    expect(claudeAccountsOutdatedHosts()).toEqual([]);
    expect(news).toBe(0);
    // Too old, then switched off: while it is off, it is not named.
    answers.studio = tooOld('studio');
    await pushClaudeAccountsNow();
    answers.studio = off('studio');
    await pushClaudeAccountsNow();
    expect(claudeAccountsOutdatedHosts()).toEqual([]);
    expect(news).toBe(2);
  });

  it('forgets a host that was removed', async () => {
    answers.laptop = tooOld('laptop');
    await pushClaudeAccountsNow();
    expect(claudeAccountsOutdatedHosts()).toEqual(['laptop']);
    hosts.pop();
    // Gone from the list at once, and from memory at the next push.
    expect(claudeAccountsOutdatedHosts()).toEqual([]);
    await pushClaudeAccountsNow();
    hosts.push({ id: 'h2', name: 'laptop', url: 'http://laptop', token: 't' });
    expect(claudeAccountsOutdatedHosts()).toEqual([]);
  });
});
