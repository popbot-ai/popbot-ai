import { describe, expect, it } from 'vitest';
import { SetupTokenParser, plainTerminalText } from './setupTokenParser';

const ESC = '\x1b';
/** Text as the CLI draws it: colour on, words apart by cursor moves. */
const drawn = (words: string[]): string => `${ESC}[38;5;246m${words.join(`${ESC}[1C`)}${ESC}[39m`;
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&state=xyz';
const TOKEN = 'sk-ant-oat01-' + 'A1b2C3d4_-'.repeat(9) + 'AA';

const opening = [
  `${ESC}[?25l${ESC}[2J${ESC}[H`,
  drawn(['Opening', 'browser', 'to', 'sign', 'in…']), '\r\n',
  drawn(['Browser', "didn't", 'open?', 'Use', 'the', 'URL', 'below', 'to', 'sign', 'in']), '\r\n',
  `${ESC}]8;;${URL}${ESC}\\${URL}${ESC}]8;;${ESC}\\`, '\r\n',
  drawn(['Paste', 'code', 'here', 'if', 'prompted']), '\r\n',
].join('');

describe('reading `claude setup-token`', () => {
  it('reads cursor moves as the spaces they skip', () => {
    expect(plainTerminalText(drawn(['Paste', 'code', 'here']))).toBe('Paste code here');
    expect(plainTerminalText(`a${ESC}[3Cb\r\nc`)).toBe('a   b\nc');
  });

  it('finds the sign-in link, then the moment the CLI wants the code', () => {
    const p = new SetupTokenParser();
    expect(p.feed(opening)).toEqual([{ type: 'url', url: URL }, { type: 'ready-for-code' }]);
    // The screen is redrawn over and over: nothing is said twice.
    expect(p.feed(opening)).toEqual([]);
    expect(p.feed(`${ESC}[2K✻ ${drawn(['Finishing', 'sign-in…'])}\r\n`)).toEqual([]);
  });

  it('survives output that arrives in pieces', () => {
    const p = new SetupTokenParser();
    const signals = [];
    for (let i = 0; i < opening.length; i += 7) signals.push(...p.feed(opening.slice(i, i + 7)));
    // A link cut mid-way is reported again once whole: the last one wins.
    expect(signals.filter((s) => s.type === 'url').at(-1)).toEqual({ type: 'url', url: URL });
    expect(signals.at(-1)).toEqual({ type: 'ready-for-code' });
  });

  it('reports a refused code with what the CLI said, minus its own prompt', () => {
    const p = new SetupTokenParser();
    p.feed(opening);
    const refused = `OAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\r\n${drawn(['Press', 'Enter', 'to', 'retry.'])}\r\n`;
    expect(p.feed(refused)).toEqual([{
      type: 'code-refused',
      message: "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
    }]);
    expect(p.feed(refused)).toEqual([]);
  });

  it('captures the token from the success screen, once', () => {
    const p = new SetupTokenParser();
    p.feed(opening);
    const success = [
      `${ESC}[32m✓ ${drawn(['Long-lived', 'authentication', 'token', 'created'])}${ESC}[39m\r\n\r\n`,
      drawn(['Your', 'OAuth', 'token', '(valid', 'for', '1', 'year):']), '\r\n\r\n',
      `${ESC}[33m${TOKEN}${ESC}[39m\r\n\r\n`,
      drawn(['Store', 'this', 'token', 'securely.', 'You', "won't", 'be', 'able', 'to', 'see', 'it', 'again.']), '\r\n',
      drawn(['Use', 'this', 'token', 'by', 'setting:', 'export', 'CLAUDE_CODE_OAUTH_TOKEN=<token>']), '\r\n',
    ].join('');
    expect(p.feed(success)).toEqual([{ type: 'token', token: TOKEN }]);
    expect(p.feed(success)).toEqual([]);
    // What is quoted from the terminal never carries the token.
    expect(p.tail()).not.toContain(TOKEN.slice(0, 30));
  });

  it('knows a sign-in that succeeded with a token it could not read', () => {
    const p = new SetupTokenParser();
    p.feed(opening);
    // Not yet: nothing has said the sign-in worked.
    expect(p.sawSuccess()).toBe(false);
    // The success screen, with a token in a shape this parser has not seen.
    const strange = 'ant-token-v2.' + 'Zz9Yy8Xx7'.repeat(10);
    const success = [
      `${ESC}[32m✓ ${drawn(['Long-lived', 'authentication', 'token', 'created'])}${ESC}[39m\r\n\r\n`,
      drawn(['Your', 'OAuth', 'token', '(valid', 'for', '1', 'year):']), '\r\n\r\n',
      `${ESC}[33m${strange}${ESC}[39m\r\n\r\n`,
    ].join('');
    expect(p.feed(success)).toEqual([]);
    expect(p.sawSuccess()).toBe(true);
    // The screen holds that token, so none of it is quoted.
    expect(p.tail()).toBe('');
  });

  it('stops saying so once the token is read, and never says it of a refused code', () => {
    const read = new SetupTokenParser();
    read.feed(opening);
    read.feed(`${ESC}[32m✓ ${drawn(['Long-lived', 'authentication', 'token', 'created'])}${ESC}[39m\r\n`);
    // The token is drawn a moment after the line above it.
    expect(read.sawSuccess()).toBe(true);
    expect(read.feed(`${TOKEN}\r\n`)).toEqual([{ type: 'token', token: TOKEN }]);
    expect(read.sawSuccess()).toBe(false);

    const refused = new SetupTokenParser();
    refused.feed(opening);
    refused.feed("OAuth error: That code wasn't accepted.\r\n");
    expect(refused.sawSuccess()).toBe(false);
  });

  it('starts over when the CLI shows a new link', () => {
    const p = new SetupTokenParser();
    p.feed(opening);
    p.feed('OAuth error: nope\r\n');
    const again = opening.replace(/state=xyz/g, 'state=second');
    expect(p.feed(again)).toEqual([{ type: 'url', url: URL.replace('state=xyz', 'state=second') }, { type: 'ready-for-code' }]);
  });

  it('quotes the last thing said when the sign-in ends some other way', () => {
    const p = new SetupTokenParser();
    p.feed(opening);
    p.feed(`${drawn(['Your', 'account', 'does', 'not', 'have', 'an', 'active', 'Claude', 'subscription.'])}\r\n`);
    expect(p.tail()).toBe('Your account does not have an active Claude subscription.');
  });
});
