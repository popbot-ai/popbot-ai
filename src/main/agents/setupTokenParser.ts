/**
 * Reads what `claude setup-token` draws on its terminal, so PopBot can run
 * that sign-in for the user (claudeSetupToken.ts) instead of sending them
 * to a terminal: the sign-in link, the moment it wants the code, a code
 * it refused, and — on success — the token itself.
 *
 * The CLI is a full-screen terminal app: its output is text interleaved
 * with cursor movement and colour sequences, redrawn many times a second.
 * What it says, in order (Claude Code 2.1):
 *
 *   Opening browser to sign in…
 *   Browser didn't open? Use the URL below to sign in
 *   https://claude.com/cai/oauth/authorize?…            (one line when wide)
 *   Paste code here if prompted
 *   …the code is typed, Enter…
 *   OAuth error: That code wasn't accepted. …           (then "Press Enter to retry.")
 *     — or —
 *   ✓ Long-lived authentication token created
 *   Your OAuth token (valid for 1 year):
 *   sk-ant-oat01-…
 *   Store this token securely. You won't be able to see it again.
 *
 * Pure: no terminal here, only its text — so it is tested on its own.
 */

export type SetupTokenSignal =
  /** The sign-in link (again, with a new one, if the CLI starts over). */
  | { type: 'url'; url: string }
  /** The CLI is waiting for the code from the sign-in page. */
  | { type: 'ready-for-code' }
  /** The code was not accepted; the CLI offers to start over. */
  | { type: 'code-refused'; message: string }
  /** Signed in: the long-lived token. */
  | { type: 'token'; token: string };

/** Terminal output as the text a person would read: cursor-forward moves
 *  become the spaces they skip, every other control sequence goes. */
export function plainTerminalText(raw: string): string {
  return raw
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.max(1, Number(n) || 1)))
    // A jump to a column mid-line stands where a gap was drawn.
    .replace(/(?<=\S)\x1b\[\d+G(?=\S)/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
/** The success screen's own words, whatever the token under them looks like. */
const SUCCESS = /Long-lived\s*authentication\s*token\s*created|Your\s*OAuth\s*token\s*\(valid/i;
const URL_RE = /https:\/\/[^\s"'<>]*oauth\/authorize\?[^\s"'<>]+/g;
/** How much terminal output is kept: the spinner redraws for as long as
 *  the user takes to sign in. */
const KEEP = 256 * 1024;

export class SetupTokenParser {
  private raw = '';
  private lastUrl: string | null = null;
  private ready = false;
  private refused = false;
  private success = false;
  private token: string | null = null;

  /** Take more terminal output; say what it newly shows, in order. */
  feed(chunk: string): SetupTokenSignal[] {
    this.raw = (this.raw + chunk).slice(-KEEP);
    const text = plainTerminalText(this.raw);
    const out: SetupTokenSignal[] = [];

    const urls = text.match(URL_RE);
    const url = urls ? urls[urls.length - 1] : null;
    if (url && url !== this.lastUrl) {
      this.lastUrl = url;
      // A new link means the CLI has started over: it will ask again.
      this.ready = false;
      this.refused = false;
      out.push({ type: 'url', url });
    }
    // Only what follows the newest link counts: once the CLI starts over,
    // the refusal still in the buffer belongs to the attempt before.
    const current = url ? text.slice(text.lastIndexOf(url)) : text;
    if (!this.ready && /Paste\s*code\s*here/i.test(current)) {
      this.ready = true;
      out.push({ type: 'ready-for-code' });
    }
    if (!this.refused) {
      const err = /OAuth\s*error:\s*([^\n]+)/i.exec(current);
      if (err) {
        this.refused = true;
        out.push({ type: 'code-refused', message: err[1].replace(/\s*Press\s*Enter\s*to\s*retry\.?\s*$/i, '').replace(/\s+/g, ' ').trim() });
      }
    }
    if (!this.success && SUCCESS.test(text)) this.success = true;
    if (!this.token) {
      const m = TOKEN.exec(text);
      if (m) {
        this.token = m[0];
        out.push({ type: 'token', token: m[0] });
      }
    }
    return out;
  }

  /** The CLI said it made a token, but none was read: it signed in, and
   *  the token it printed is not one this parser knows the look of. What
   *  is on the screen then must not be quoted — the token is in it. */
  sawSuccess(): boolean {
    return this.success && !this.token;
  }

  /** The last things the CLI said — for a sign-in that ended some other
   *  way (an account on hold, no subscription). Never a token. */
  tail(): string {
    // Past the success screen the token is on it, perhaps in a new shape.
    if (this.success) return '';
    const lines = plainTerminalText(this.raw)
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      // Not the logo, the spinner or the input box.
      .filter((l) => l.length > 2 && /[A-Za-z]{3}/.test(l) && !/^[\s│╭╮╰╯─*·✢✳✶✻✽█▓░▄.]+$/.test(l))
      .filter((l) => !/^https?:\/\//.test(l) && !/Paste\s*code\s*here|Opening browser|Browser didn.t open|Welcome to Claude Code/i.test(l));
    const unique = lines.filter((l, i) => lines.lastIndexOf(l) === i);
    return unique.slice(-2).join(' ').replace(new RegExp(TOKEN.source, 'g'), '[token]').slice(0, 300);
  }
}
