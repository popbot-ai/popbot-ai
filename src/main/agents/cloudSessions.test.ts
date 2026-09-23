import { describe, expect, it } from 'vitest';
import { cloudActionFor, parseCloudSendOutput, parseCloudSessionRef, stripAnsi } from './cloudSessions';

describe('parseCloudSessionRef', () => {
  it('reads the id out of the CLI’s text output', () => {
    const out = 'Sent to cloud session.\nSession ID: session_01DiUkqY2kzbUbDmW1w96rfi\nView: https://claude.ai/code/session_01DiUkqY2kzbUbDmW1w96rfi?from=cli&m=0\n';
    expect(parseCloudSessionRef(out)).toEqual({
      sessionId: 'session_01DiUkqY2kzbUbDmW1w96rfi',
      url: 'https://claude.ai/code/session_01DiUkqY2kzbUbDmW1w96rfi',
    });
  });

  it('accepts a pasted claude.ai/code link, with or without a query string', () => {
    expect(parseCloudSessionRef('claude.ai/code/session_01ABCDEFGHIJ?from=cli')?.sessionId).toBe('session_01ABCDEFGHIJ');
    expect(parseCloudSessionRef('https://claude.ai/code/cse_0123456789ab')?.sessionId).toBe('cse_0123456789ab');
  });

  it('sees through terminal colour codes and ignores unrelated text', () => {
    expect(parseCloudSessionRef('\x1b[32m✓\x1b[0m Session \x1b[1msession_01ZZZZZZZZZZ\x1b[0m ready')?.sessionId)
      .toBe('session_01ZZZZZZZZZZ');
    expect(parseCloudSessionRef('claude --cloud "fix the session_ handling"')).toBeNull();
    expect(parseCloudSessionRef('nothing here')).toBeNull();
  });
});

describe('parseCloudSendOutput', () => {
  it('takes the JSON result line', () => {
    const r = parseCloudSendOutput('{"ok":true,"session_id":"session_01ABCDEFGHIJ","url":"https://claude.ai/code/session_01ABCDEFGHIJ"}\n', '', 0);
    expect(r).toEqual({ ok: true, sessionId: 'session_01ABCDEFGHIJ', url: 'https://claude.ai/code/session_01ABCDEFGHIJ' });
  });

  it('reports the CLI’s own error for a failed delivery', () => {
    const r = parseCloudSendOutput('{"ok":false,"session_id":"session_01ABCDEFGHIJ","error":"cloud session session_01ABCDEFGHIJ is archived and cannot accept new messages"}', '', 1);
    expect(r).toEqual({ ok: false, error: 'cloud session session_01ABCDEFGHIJ is archived and cannot accept new messages' });
  });

  it('reports a configuration error that came without JSON', () => {
    const r = parseCloudSendOutput('', "Error: Cloud sessions are disabled by your organization's policy. Contact your organization admin to enable them.\n", 1);
    expect(r).toEqual({ ok: false, error: "Cloud sessions are disabled by your organization's policy. Contact your organization admin to enable them." });
  });

  it('accepts the plain-text success form too', () => {
    const r = parseCloudSendOutput('Sent to cloud session.\nSession ID: session_01ABCDEFGHIJ\nView: https://claude.ai/code/session_01ABCDEFGHIJ?from=cli&m=0\n', '', 0);
    expect(r).toEqual({ ok: true, sessionId: 'session_01ABCDEFGHIJ', url: 'https://claude.ai/code/session_01ABCDEFGHIJ' });
  });

  it('falls back to the exit code when nothing was said', () => {
    expect(parseCloudSendOutput('', '', 2)).toEqual({ ok: false, error: 'claude exited with code 2' });
  });
});

describe('cloudActionFor', () => {
  const none = { provider: 'claude' as const, sessionId: null, url: null, startedAt: null };
  it('starts a session on the first message, waits while it is being created, then queues follow-ups', () => {
    expect(cloudActionFor(none, false)).toBe('start');
    expect(cloudActionFor(none, true)).toBe('wait');
    expect(cloudActionFor({ ...none, sessionId: 'session_01ABCDEFGHIJ' }, true)).toBe('follow-up');
  });
});

describe('stripAnsi', () => {
  it('removes colour, cursor and title sequences', () => {
    expect(stripAnsi('\x1b[?25l\x1b[1;32mhi\x1b[0m\x1b]0;title\x07 there')).toBe('hi there');
  });
});
