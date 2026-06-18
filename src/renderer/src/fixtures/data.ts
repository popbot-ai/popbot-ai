/**
 * Seed/demo data used by the renderer until the IPC layer is wired to real
 * sources (Linear, GitHub, Slack, the slot manager, the agent backend).
 *
 * Mirrors design/prototype/data.jsx 1:1; new fields go here when the
 * prototype's shape needs to grow.
 */

export type ChatStatus = 'run' | 'done' | 'wait' | 'err' | 'idle';

export interface Ticket {
  id: string;
  title: string;
  status: 'In Progress' | 'Triage' | 'Backlog';
  priority: 'urgent' | 'high' | 'med' | 'low';
  project: string;
  /** Markdown description from Linear (when wired live). */
  description?: string;
  /** Direct link to the ticket in Linear. */
  url?: string;
}

export interface PR {
  num: number;
  title: string;
  author: string;
  state: 'wait_you' | 'rabbit' | 'checks' | 'noreview';
  comments: number;
  checks: 'ok' | 'fail';
}

export interface SlackItem {
  ch: string;
  who: string;
  t: string;
  text: string;
  unread: boolean;
  thread: number;
  mention: boolean;
  bot?: boolean;
}

export interface Chat {
  id: string;
  name: string;
  branch: string;
  status: ChatStatus;
  timestamp: string;
  tokens: { used: number; budget: number };
  snippet: string;
  type: 'lite' | 'client_test' | 'server_test';
  ticket?: string;
  pr?: number;
  agent?: 'claude' | 'codex';
  /** Workspace slot held by this chat (1-based), or null if none. */
  slotId?: number | null;
  /** Absolute path of the slot's git worktree, or null. Used by the
   *  SlotAppButtons launcher row. */
  worktreePath?: string | null;
  /** Repo accent color from the live ChatRecord — drives the
   *  per-chat MonitorCard ring + thumb tint. Only present on chats
   *  projected from a real repo row. */
  repoColor?: string | null;
}

export interface InactiveChat {
  id: string;
  name: string;
  branch: string;
  status: ChatStatus;
  timestamp: string;
}

export type ActivityKind = 'tool' | 'say' | 'user' | 'diff' | 'perm';

export interface ActivityItem {
  kind: ActivityKind;
  text?: string;
  name?: string;
  args?: string;
  t?: string;
  path?: string;
  add?: number;
  rem?: number;
}

export const TICKETS: Ticket[] = [
  { id: 'ENG-20512', title: 'Hero ability cooldown sometimes shows 0.0s on client', status: 'In Progress', priority: 'high', project: 'Combat' },
  { id: 'ENG-20498', title: 'Inventory drag preview flickers when stack count changes', status: 'Triage', priority: 'med', project: 'UI' },
  { id: 'ENG-20447', title: 'Crash on boot when Library cache > 8 GB', status: 'In Progress', priority: 'urgent', project: 'Platform' },
  { id: 'ENG-20402', title: 'Add server timestamp to ability resolve packets', status: 'Backlog', priority: 'med', project: 'Net' },
  { id: 'ENG-20371', title: 'Lobby music ducks under sfx with wrong curve', status: 'Backlog', priority: 'low', project: 'Audio' },
  { id: 'ENG-20355', title: 'Boss arena loadtime regression after addressables update', status: 'Triage', priority: 'high', project: 'Build' },
  { id: 'ENG-20312', title: 'Player input buffered across scene transitions', status: 'Backlog', priority: 'med', project: 'Input' },
];

export const PRS: PR[] = [
  { num: 7401, title: 'Refactor ability resolver to use deterministic seeds', author: 'MK', state: 'wait_you', comments: 4, checks: 'ok' },
  { num: 7398, title: 'Inventory grid virtualization (closes ENG-20498)', author: 'JR', state: 'rabbit', comments: 1, checks: 'ok' },
  { num: 7395, title: 'Bump unity-mcp to 0.7.2', author: 'TS', state: 'checks', comments: 0, checks: 'fail' },
  { num: 7390, title: 'Boss arena addressable groups split', author: 'AE', state: 'noreview', comments: 0, checks: 'ok' },
  { num: 7382, title: 'Server: idempotent reward grant for combat rewards', author: 'MK', state: 'wait_you', comments: 7, checks: 'ok' },
];

export const SLACK: SlackItem[] = [
  { ch: '#engineering', who: 'kira', t: '2m', text: '@you any ideas why the cooldown HUD reads 0.0 for one frame? saw your branch', unread: true, thread: 3, mention: true },
  { ch: '#tech-platform', who: 'marco', t: '8m', text: '@you Library cache crash repro — got a 14GB dump if you want to point a tool at it', unread: true, thread: 0, mention: true },
  { ch: '#engineering', who: 'tess', t: '12m', text: "PR #7401 ready for another pass when you're done with the cooldown one", unread: true, thread: 1, mention: false },
  { ch: '#design-combat', who: 'ana', t: '32m', text: 'values for new boss arena loadtime budget — pinning here', unread: false, thread: 6, mention: false },
  { ch: '#qa-buildbot', who: 'buildbot', t: '1h', text: 'develop · Unity build #14821 · ✓ green · 14m22s', unread: false, thread: 0, mention: false, bot: true },
  { ch: '#random', who: 'rj', t: '3h', text: 'anyone in office friday? bringing donuts', unread: false, thread: 11, mention: false },
];

export const INITIAL_CHATS: Chat[] = [
  { id: 'c1', name: 'ENG-20512 · ability cooldown', branch: 'eng/20512-cooldown-display', status: 'run', timestamp: 'active now', tokens: { used: 412_000, budget: 1_000_000 }, snippet: 'Patching CooldownView to use server-stamped expiry. Re-running fixture combat-ability-loop…', type: 'client_test', ticket: 'ENG-20512' },
  { id: 'c2', name: 'ENG-20447 · library cache crash', branch: 'eng/20447-library-cache', status: 'wait', timestamp: '1m ago — needs you', tokens: { used: 712_000, budget: 1_000_000 }, snippet: 'Permission needed: agent wants to run `git push origin eng/20447-library-cache` to back up progress.', type: 'client_test', ticket: 'ENG-20447' },
  { id: 'c3', name: 'PR #7401 review', branch: 'review/7401-ability-resolver', status: 'run', timestamp: 'active now', tokens: { used: 188_000, budget: 1_000_000 }, snippet: 'Walking through resolver.cs hunk 3/8. Determinism looks good but seed plumbing leaks into UI layer.', type: 'lite', pr: 7401 },
  { id: 'c4', name: 'Boss arena loadtime', branch: 'eng/20355-arena-loadtime', status: 'done', timestamp: '12m ago — finished', tokens: { used: 540_000, budget: 1_000_000 }, snippet: "Identified 3 addressable groups loading on bootstrap that shouldn't. Patch ready, opened PR #7402.", type: 'client_test', ticket: 'ENG-20355' },
  { id: 'c5', name: 'Inventory flicker', branch: 'eng/20498-inv-flicker', status: 'idle', timestamp: '31m ago — paused', tokens: { used: 96_000, budget: 1_000_000 }, snippet: 'Reproduced in fixture inv-stack-resize. Awaiting your direction on stack-count source of truth.', type: 'client_test', ticket: 'ENG-20498' },
];

export const INACTIVE_CHATS: InactiveChat[] = [
  { id: 'x1', name: 'Reward grant idempotency', branch: 'eng/20211-rewards-idem', status: 'done', timestamp: 'yesterday' },
  { id: 'x2', name: 'Server timestamp packets', branch: 'eng/20402-srv-ts', status: 'done', timestamp: '2d ago' },
  { id: 'x3', name: 'Lobby audio mix', branch: 'eng/20371-audio-ducking', status: 'err', timestamp: '3d ago' },
  { id: 'x4', name: 'Hotfix: scene transition input', branch: 'eng/20312-input-buffer', status: 'done', timestamp: '3d ago' },
];

export const CHAT_ACTIVITY: Record<string, ActivityItem[]> = {
  c1: [
    { kind: 'tool', name: 'unity.run_fixture', args: 'combat-ability-loop ×10', t: '0:02' },
    { kind: 'say', text: 'Re-running fixture to confirm 0.0s flicker is gone after CooldownView patch.' },
    { kind: 'user', text: 'Run fixture 10× to confirm; if green push a draft PR.' },
    { kind: 'diff', path: 'Assets/UI/HUD/CooldownView.cs', add: 4, rem: 2 },
    { kind: 'tool', name: 'unity.read_log', args: 'pattern="cd-flicker"', t: '0:14' },
    { kind: 'say', text: 'Found it — HUD reads localExpiry instead of server-stamped one for one frame.' },
    { kind: 'tool', name: 'unity.run_fixture', args: 'combat-ability-loop', t: '0:22' },
  ],
  c2: [
    { kind: 'perm', text: 'Wants: git push origin eng/20447-library-cache' },
    { kind: 'say', text: 'Promoting offsets to long. Backing up worktree before more invasive changes.' },
    { kind: 'tool', name: 'unity.read_log', args: 'pattern="OverflowException"', t: '0:08' },
    { kind: 'say', text: 'Trace points at AssetBundleManifest hitting a 32-bit offset overflow.' },
    { kind: 'tool', name: 'fs.read', args: 'LibraryCache.cs L120-180', t: '0:18' },
  ],
  c3: [
    { kind: 'tool', name: 'git.diff', args: 'base=develop head=pr/7401', t: '0:05' },
    { kind: 'say', text: 'Hunk 3: AbilityHints reaches into Resolver.CurrentSeed — couples sim to UI layer.' },
    { kind: 'tool', name: 'fs.read', args: 'Assets/UI/AbilityHints.cs', t: '0:11' },
    { kind: 'say', text: "Drafting a comment suggesting we expose a stable hint-rng via resolver's public API." },
    { kind: 'tool', name: 'github.draft_review', args: 'pr=7401', t: '0:18' },
  ],
  c4: [
    { kind: 'say', text: 'Done — pushed branch, opened PR #7402, posted summary to ENG-20355.' },
    { kind: 'tool', name: 'github.open_pr', args: "title='Boss arena lazy-load'", t: '11:42' },
    { kind: 'diff', path: 'Addressables/groups/boss_arena.asset', add: 3, rem: 3 },
    { kind: 'tool', name: 'unity.profile', args: 'scene="BossArena_01"', t: '11:18' },
  ],
  c5: [
    { kind: 'say', text: 'Awaiting your direction on stack-count source of truth (Option A vs B).' },
    { kind: 'tool', name: 'unity.run_fixture', args: 'inv-stack-resize', t: '31:02' },
    { kind: 'say', text: 'Reproduced flicker in fixture inv-stack-resize.' },
  ],
};

export const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
};

export const tokenBarClass = (used: number, budget: number): string => {
  const p = used / budget;
  if (p > 0.85) return 'crit';
  if (p > 0.6) return 'warn';
  return '';
};

/** Visual *length* of a chat — bucketed (log-ish), so a 100-token chat
 *  isn't an invisible sliver and a 200k-token chat doesn't blow it out
 *  of proportion to a 30k one. Width is intent, not precision. Color
 *  is a separate channel (see tokenBarClass) for budget pressure. */
const TOKEN_BUCKETS: Array<[max: number, pct: number]> = [
  [0, 0],
  [200, 6],
  [1_000, 12],
  [5_000, 22],
  [15_000, 35],
  [40_000, 50],
  [100_000, 68],
  [250_000, 84],
  [Infinity, 100],
];
export const tokenBarPct = (used: number): number => {
  for (const [max, pct] of TOKEN_BUCKETS) {
    if (used <= max) return pct;
  }
  return 100;
};

export const avatarColor = (s: string): string => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `oklch(0.55 0.12 ${h})`;
};
