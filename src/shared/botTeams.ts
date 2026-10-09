/**
 * Who may wake a bot through a GitHub trigger: the people its "member of
 * team" field allows — as the pull request's author, or as whoever put
 * the trigger's label on it. A repository may be public, so a pull
 * request nobody on the team opened or chose must never reach a bot that
 * reviews, checks out and pushes code. A team member labeling one (a
 * bot's, a contributor's) is that choice: labeling takes triage access,
 * and the labeler still has to be on the team.
 *
 *   ""            no one — the default, so an unset field fails closed
 *   "devs"        members of the team `devs` in the repository's org
 *   "org/devs"    members of the team `devs` in `org`
 *   "org/*"       members of `org`
 *   "a, b/c"      members of any of them
 *   "*"           anyone — only when typed on purpose
 */

export interface TeamSpec {
  /** "*": every author. */
  anyone: boolean;
  /** Teams (`team` set) and whole orgs (`team` null). */
  groups: Array<{ org: string; team: string | null }>;
}

const ORG = '[A-Za-z0-9][A-Za-z0-9-]*';
const TEAM = '[A-Za-z0-9][A-Za-z0-9._-]*';
const ENTRY = new RegExp(`^(?:@?(${ORG})/(\\*|${TEAM})|(${TEAM}))$`);

function entries(spec: string): string[] {
  return spec.split(',').map((p) => p.trim()).filter(Boolean);
}

/** `org` is the repository's owner, for bare team names. */
export function parseTeamSpec(spec: string, org: string): TeamSpec {
  const parts = entries(spec);
  if (parts.includes('*')) return { anyone: true, groups: [] };
  const groups: TeamSpec['groups'] = [];
  for (const part of parts) {
    const m = ENTRY.exec(part);
    if (!m) continue;
    if (m[3]) groups.push({ org, team: m[3] });
    else groups.push({ org: m[1], team: m[2] === '*' ? null : m[2] });
  }
  return { anyone: false, groups };
}

/** What in a spec is not a team, `org/team`, `org/*` or `*`. */
export function teamSpecProblems(spec: string): string[] {
  return entries(spec).filter((p) => p !== '*' && !ENTRY.test(p));
}

/** May this author wake the bot, given everyone in the spec's groups? */
export function authorAllowed(spec: TeamSpec, author: string, members: Set<string>): boolean {
  if (spec.anyone) return true;
  return members.has(author.toLowerCase());
}

/** Who last put each of `labels` on a pull request, from its labeling
 *  events (oldest first) — only the latest counts, so a label taken off
 *  and put back by someone else is theirs now. */
export function labelers(labels: string[], events: Array<{ label: string; actor: string }>): string[] {
  const watched = new Set(labels.map((l) => l.toLowerCase()));
  const last = new Map<string, string>();
  for (const e of events) {
    if (e.actor && watched.has(e.label.toLowerCase())) last.set(e.label.toLowerCase(), e.actor);
  }
  return [...new Set(last.values())];
}

/** The team member who let this pull request through — its author, or
 *  else whoever labeled it — or null when no one on the team did. */
export function teamMemberFor(spec: TeamSpec, author: string, labeledBy: string[], members: Set<string>): string | null {
  if (authorAllowed(spec, author, members)) return author;
  return labeledBy.find((who) => authorAllowed(spec, who, members)) ?? null;
}

/** The field, in words. */
export function describeTeamSpec(spec: string, org: string): string {
  const s = parseTeamSpec(spec, org);
  if (s.anyone) return 'anyone';
  if (s.groups.length === 0) return 'no one';
  return s.groups.map((g) => (g.team ? `${g.org}/${g.team}` : `the ${g.org} org`)).join(' or ');
}
