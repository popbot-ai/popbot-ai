import { describe, expect, it } from 'vitest';
import { judgeTokenCheck } from './claudeTokenCheck';

// What Claude Code 2.1.327 prints for `-p --output-format stream-json --verbose`,
// trimmed to the fields that are read (and a few that are not).
const NOW = Date.UTC(2026, 10, 19, 22, 0);
const RESET_S = Math.floor(NOW / 1000) + 2 * 24 * 3600;
const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const init = { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-haiku-5-5' };
const LIMIT_TEXT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your weekly limit resets 11am (America/Los_Angeles)";

const answered = lines(
  init,
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: RESET_S, rateLimitType: 'seven_day', overageStatus: 'rejected' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
  { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'OK', terminal_reason: 'completed' },
);
const refused = lines(
  init,
  {
    type: 'result', subtype: 'success', is_error: true, api_error_status: 401, api_error_type: 'authentication_error',
    result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', terminal_reason: 'api_error',
  },
);
const outOfUsage = lines(
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'seven_day', overageStatus: 'rejected' } },
  init,
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] }, error: 'rate_limit' },
  {
    type: 'result', subtype: 'success', is_error: true, api_error_status: 429, api_error_type: 'rate_limit_error',
    api_error: 'usage_limit_reached', result: LIMIT_TEXT, terminal_reason: 'api_error',
  },
);

describe('what a token check found', () => {
  it('passes a sign-in Claude answered on', () => {
    expect(judgeTokenCheck(0, answered, '', NOW)).toEqual({ ok: true });
  });

  it('passes whatever the reply says: the sign-in is what is checked', () => {
    const chatty = lines(init, { type: 'result', is_error: false, api_error_status: null, result: 'Sure! Here is an invalid 401 joke.' });
    expect(judgeTokenCheck(0, chatty, '', NOW)).toEqual({ ok: true });
  });

  it('calls a 401 a refusal, in the CLI’s words', () => {
    expect(judgeTokenCheck(1, refused, '', NOW)).toEqual({
      ok: false,
      error: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      refused: true,
    });
  });

  it('calls a 403 a refusal too', () => {
    const forbidden = lines({ type: 'result', is_error: true, api_error_status: 403, api_error_type: 'permission_error', result: 'This account cannot use Claude Code.' });
    expect(judgeTokenCheck(1, forbidden, '', NOW)).toMatchObject({ ok: false, refused: true, error: 'This account cannot use Claude Code.' });
  });

  it('passes an account that is signed in but out of usage, with when it resets', () => {
    expect(judgeTokenCheck(1, outOfUsage, '', NOW)).toEqual({ ok: true, outOfUsage: { resetsAt: RESET_S * 1000 } });
  });

  it('says out of usage without a reset when the CLI gave none, or one already past', () => {
    const noEvent = lines(init, { type: 'result', is_error: true, api_error_status: 429, api_error_type: 'rate_limit_error', api_error: 'usage_limit_reached', result: LIMIT_TEXT });
    expect(judgeTokenCheck(1, noEvent, '', NOW)).toEqual({ ok: true, outOfUsage: { resetsAt: null } });
    expect(judgeTokenCheck(1, outOfUsage, '', (RESET_S + 60) * 1000)).toEqual({ ok: true, outOfUsage: { resetsAt: null } });
    // Only the words say it.
    const wordsOnly = lines(init, { type: 'result', is_error: true, result: "You've hit your limit · resets 5pm" });
    expect(judgeTokenCheck(1, wordsOnly, '', NOW)).toEqual({ ok: true, outOfUsage: { resetsAt: null } });
  });

  it('passes a sign-in that was only told to slow down', () => {
    const busy = lines(init, { type: 'result', is_error: true, api_error_status: 429, api_error_type: 'rate_limit_error', result: 'API Error: 429 Too many requests.' });
    expect(judgeTokenCheck(1, busy, '', NOW)).toEqual({ ok: true });
  });

  it('does not pass, and does not call refused, a failure that says nothing about the sign-in', () => {
    const down = lines(init, { type: 'result', is_error: true, api_error_status: 529, api_error_type: 'overloaded_error', result: 'API Error: 529 Overloaded.' });
    expect(judgeTokenCheck(1, down, '', NOW)).toEqual({ ok: false, error: 'API Error: 529 Overloaded.' });
    const quiet = lines(init, { type: 'result', is_error: true, result: '' });
    expect(judgeTokenCheck(1, quiet, '', NOW)).toEqual({ ok: false, error: 'the CLI exited 1' });
  });

  it('reads a refusal a CLI with no status only says in words', () => {
    const old = lines({ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' });
    expect(judgeTokenCheck(1, old, '', NOW)).toMatchObject({ ok: false, refused: true });
  });

  describe('with no result to read (a CLI that failed first, or one too old for events)', () => {
    it('goes by its words', () => {
      expect(judgeTokenCheck(0, 'OK\n', '', NOW)).toEqual({ ok: true });
      expect(judgeTokenCheck(1, '', 'Failed to authenticate. API Error: 401 OAuth access token has expired.\n', NOW)).toEqual({
        ok: false,
        error: 'Failed to authenticate. API Error: 401 OAuth access token has expired.',
        refused: true,
      });
      expect(judgeTokenCheck(1, `${LIMIT_TEXT}\n`, '', NOW)).toEqual({ ok: true, outOfUsage: { resetsAt: null } });
      expect(judgeTokenCheck(1, 'Credit balance is too low\n', '', NOW)).toEqual({ ok: false, error: 'Credit balance is too low' });
      expect(judgeTokenCheck(1, '', "error: unknown option '--output-format'\n", NOW)).toEqual({ ok: false, error: "error: unknown option '--output-format'" });
      expect(judgeTokenCheck(3, '', '', NOW)).toEqual({ ok: false, error: 'the CLI exited 3' });
      // Ended well, but said nothing that shows the request was answered.
      expect(judgeTokenCheck(0, 'Usage: claude [options]\n', '', NOW)).toMatchObject({ ok: false });
    });
  });

  it('never repeats a token the CLI printed', () => {
    const leak = lines({ type: 'result', is_error: true, api_error_status: 500, result: 'Bad header: Bearer sk-ant-oat01-SECRETsecretSECRET_-x' });
    const verdict = judgeTokenCheck(1, leak, '', NOW);
    expect(verdict).toEqual({ ok: false, error: 'Bad header: Bearer [token]' });
  });
});
