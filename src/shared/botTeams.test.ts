import { describe, expect, it } from 'vitest';
import { authorAllowed, describeTeamSpec, labelers, parseTeamSpec, teamMemberFor, teamSpecProblems } from './botTeams';

const members = new Set(['alice', 'bob']);

describe('who may wake a bot through a GitHub trigger', () => {
  it('lets no one through when the team is blank', () => {
    const spec = parseTeamSpec('', 'acme');
    expect(spec).toEqual({ anyone: false, groups: [] });
    expect(authorAllowed(spec, 'alice', new Set())).toBe(false);
    expect(describeTeamSpec('  ', 'acme')).toBe('no one');
  });

  it("reads a bare name as a team in the repository's org", () => {
    expect(parseTeamSpec('web_devs', 'acme').groups).toEqual([{ org: 'acme', team: 'web_devs' }]);
    expect(parseTeamSpec('other/devs, other/*', 'acme').groups).toEqual([{ org: 'other', team: 'devs' }, { org: 'other', team: null }]);
    expect(describeTeamSpec('web_devs, other/*', 'acme')).toBe('acme/web_devs or the other org');
  });

  it('lets only members through', () => {
    const spec = parseTeamSpec('web_devs', 'acme');
    expect(authorAllowed(spec, 'Alice', members)).toBe(true);
    expect(authorAllowed(spec, 'mallory', members)).toBe(false);
  });

  it('lets anyone through only on an explicit *', () => {
    expect(authorAllowed(parseTeamSpec('*', 'acme'), 'mallory', new Set())).toBe(true);
    expect(describeTeamSpec('*', 'acme')).toBe('anyone');
  });

  it('names what is not a team', () => {
    expect(teamSpecProblems('web_devs, acme/web-devs, acme/*, *')).toEqual([]);
    expect(teamSpecProblems('web devs, a/b/c, /x')).toEqual(['web devs', 'a/b/c', '/x']);
  });

  it("lets a pull request through when a member labeled it, though they didn't open it", () => {
    const spec = parseTeamSpec('web_devs', 'acme');
    const events = [
      { label: 'webreview', actor: 'claude[bot]' },
      { label: 'risk:high', actor: 'alice' },
      { label: 'WebReviewer', actor: 'bob' },
    ];
    expect(labelers(['webreviewer'], events)).toEqual(['bob']);
    expect(teamMemberFor(spec, 'claude[bot]', labelers(['webreviewer'], events), members)).toBe('bob');
    // Another label of theirs, or a watched label put on by an outsider, is not enough.
    expect(teamMemberFor(spec, 'claude[bot]', labelers(['webreview'], events), members)).toBeNull();
    expect(teamMemberFor(spec, 'mallory', labelers(['risk:high'], [{ label: 'risk:high', actor: 'mallory' }]), members)).toBeNull();
  });

  it('counts only whoever last put the label on', () => {
    const events = [{ label: 'review', actor: 'alice' }, { label: 'review', actor: 'mallory' }];
    expect(teamMemberFor(parseTeamSpec('web_devs', 'acme'), 'mallory', labelers(['review'], events), members)).toBeNull();
  });

  it('names the author first when they are on the team', () => {
    expect(teamMemberFor(parseTeamSpec('web_devs', 'acme'), 'alice', ['bob'], members)).toBe('alice');
  });
});
