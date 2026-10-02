/**
 * Who may wake a bot through a GitHub trigger: the authors its "member
 * of team" field allows. A repository may be public, so a pull request
 * from anyone else must never reach a bot that reviews, checks out and
 * pushes code.
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

/** The field, in words. */
export function describeTeamSpec(spec: string, org: string): string {
  const s = parseTeamSpec(spec, org);
  if (s.anyone) return 'anyone';
  if (s.groups.length === 0) return 'no one';
  return s.groups.map((g) => (g.team ? `${g.org}/${g.team}` : `the ${g.org} org`)).join(' or ');
}
