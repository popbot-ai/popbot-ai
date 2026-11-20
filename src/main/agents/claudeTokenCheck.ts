/**
 * What the Claude CLI's answer to PopBot's one tiny request says about the
 * token it ran on (claudeAccounts.ts sends the request).
 *
 * The question is whether Claude takes the sign-in — not whether the
 * request got its reply. An account that is signed in but out of usage
 * answers with its limit instead of "OK", and it is still an account to
 * keep: it is what the chats come back to once it resets. So the answer
 * is read as the CLI reports it (`--output-format stream-json`): the
 * result's API status, and the rate-limit event that carries the reset.
 *
 *   signed in, answered            result  is_error:false
 *   sign-in refused                result  api_error_status:401, api_error_type:"authentication_error"
 *   signed in, out of usage        result  api_error_status:429, api_error:"usage_limit_reached"
 *                                  rate_limit_event  rate_limit_info:{ status:"rejected", resetsAt:<seconds> }
 *
 * Pure: the CLI's output in, the verdict out.
 */
import { USAGE_LIMIT_TEXT } from './claudeAuth';

export type ClaudeTokenCheck =
  /** Claude takes the sign-in. `outOfUsage`: but the account has no usage
   *  left until `resetsAt` (ms; null when the CLI did not say when). */
  | { ok: true; outOfUsage?: { resetsAt: number | null } }
  /** `error` is what the CLI said. `timedOut`: it never answered;
   *  `refused`: it answered, and what it said is that the sign-in is no good. */
  | { ok: false; error: string; timedOut?: boolean; refused?: boolean };

/** How the CLI words a sign-in it will not run on. */
const REFUSED = /authenticat|401|invalid|expired|revoked/i;

/** What the CLI said, fit to show and to log: one line, and never a token. */
function clip(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function judgeTokenCheck(exitCode: number | null, stdout: string, stderr = '', now = Date.now()): ClaudeTokenCheck {
  let result: Record<string, unknown> | null = null;
  let limit: Record<string, unknown> | null = null;
  const plain: string[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown = null;
    if (text.startsWith('{')) {
      try { parsed = JSON.parse(text); } catch { /* not an event: something the CLI printed */ }
    }
    if (!parsed || typeof parsed !== 'object') { plain.push(text); continue; }
    const event = parsed as Record<string, unknown>;
    if (event.type === 'result') result = event;
    else if (event.type === 'rate_limit_event' && event.rate_limit_info && typeof event.rate_limit_info === 'object') {
      limit = event.rate_limit_info as Record<string, unknown>;
    }
  }
  const limitHit = limit?.status === 'rejected';
  const resetsMs = limitHit && typeof limit?.resetsAt === 'number' ? limit.resetsAt * 1000 : 0;
  const outOfUsage = { resetsAt: resetsMs > now ? resetsMs : null };

  if (result) {
    if (result.is_error !== true) return { ok: true };
    const said = clip(typeof result.result === 'string' ? result.result : '');
    const status = typeof result.api_error_status === 'number' ? result.api_error_status : null;
    const kind = typeof result.api_error_type === 'string' ? result.api_error_type : '';
    if (status === 401 || status === 403 || kind === 'authentication_error' || kind === 'permission_error') {
      return { ok: false, error: said || `Claude answered ${status ?? kind}.`, refused: true };
    }
    // Claude knew the account well enough to say it has nothing left.
    if (result.api_error === 'usage_limit_reached' || limitHit || USAGE_LIMIT_TEXT.test(said)) return { ok: true, outOfUsage };
    // Too many requests just now: still an answer only a signed-in account gets.
    if (status === 429 || kind === 'rate_limit_error') return { ok: true };
    // A CLI that gives no status says a refusal only in words.
    if (status === null && REFUSED.test(said)) return { ok: false, error: said, refused: true };
    return { ok: false, error: said || `the CLI exited ${exitCode}` };
  }

  // No result at all: a CLI that failed before asking, or one too old for
  // the event stream. Its words are all there is to go by.
  const text = clip([...plain, stderr].join(' '));
  if (REFUSED.test(text)) return { ok: false, error: text, refused: true };
  if (USAGE_LIMIT_TEXT.test(text)) return { ok: true, outOfUsage };
  if (exitCode === 0 && /\bOK\b/.test(text)) return { ok: true };
  return { ok: false, error: text || `the CLI exited ${exitCode}` };
}
