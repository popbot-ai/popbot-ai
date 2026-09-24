/**
 * The transcript search query language: free text plus `key:value` tags,
 * typed into the Search panel or passed to the popbot `search_chats`
 * tool. Main parses it (so both get the same syntax) and turns the tags
 * into SQL predicates next to the full-text match.
 *
 *   ticket:            only ticket chats        ticket:ENG-123   one ticket
 *   cr:                only code-review chats   cr:123           one PR / review
 *   last:week          messages from the last day | week | month | year,
 *                      or a count: last:3d, last:2w, last:6m
 *   from:user          who wrote it: user | agent | tool | system (comma list).
 *                      Without it a search covers what the user and the
 *                      agent wrote; tool calls, their output (patches,
 *                      command output) and system notes only with from:.
 *   tool:Bash          tool calls whose tool name contains this
 *   agent:codex        chats driven by claude | codex
 *   in:archive         archived chats only; in:open; in:all (the default)
 *   chat:login+bug     chats whose name contains every `+`-joined word;
 *                      chat:chat_1a2b3c… (an id, what a completion inserts) one chat
 *   repo:app           chats in this repository
 *
 * In a tag value `+` joins words that must all match (`chat:login+bug`),
 * so a multi-word title needs no quotes; quotes still work. `+` means
 * nothing special in the free text. Anything else — including
 * `key:value` pairs with an unknown key, so a URL still searches as
 * text — is the text to search for.
 */

export type SearchWho = 'user' | 'agent' | 'tool' | 'system';

export interface SearchFilters {
  /** `true` = any ticket chat; a string = that ticket. */
  ticket?: string | true;
  /** `true` = any code-review chat; a number = that PR / review. */
  cr?: number | true;
  /** Milliseconds back from now. */
  lastMs?: number;
  from?: SearchWho[];
  /** Every word must appear in the tool name. */
  tool?: string[];
  agent?: 'claude' | 'codex';
  in?: 'open' | 'archive' | 'all';
  /** Every word must appear in the chat name. */
  chat?: string[];
  /** Exactly this chat (a `chat:` value that is a chat id). */
  chatId?: string;
  repo?: string;
}

export interface ParsedSearchQuery {
  /** The free text, tags removed, whitespace collapsed. */
  text: string;
  filters: SearchFilters;
  /** Whether any tag was given. */
  hasFilters: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const LAST_WORDS: Record<string, number> = { day: DAY, '24h': DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };
const LAST_UNITS: Record<string, number> = { h: 60 * 60 * 1000, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY };
const WHO = new Set<SearchWho>(['user', 'agent', 'tool', 'system']);

/** Split on whitespace, keeping quoted runs together: `key:"a value"`
 *  is one token (the value's quotes are stripped when parsed), as is a
 *  bare `"some words"`. */
function tokenize(raw: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z]+:"[^"]*")|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

const unquote = (v: string): string => v.replace(/^"(.*)"$/, '$1').trim();

/** A tag value's words: `+`-joined (and, inside quotes, space-separated). */
export function tagWords(value: string): string[] {
  return value.split(/[+\s]+/).map((w) => w.trim()).filter(Boolean);
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const filters: SearchFilters = {};
  const words: string[] = [];
  for (const tok of tokenize(raw)) {
    const m = /^([a-z]+):(.*)$/i.exec(tok);
    if (!m) { words.push(tok); continue; }
    const key = m[1].toLowerCase();
    const val = unquote(m[2].trim());
    switch (key) {
      case 'ticket':
        filters.ticket = val ? val.toUpperCase() : true;
        continue;
      case 'cr':
      case 'pr':
        filters.cr = /^\d+$/.test(val) ? Number(val) : true;
        continue;
      case 'last':
      case 'since': {
        const word = LAST_WORDS[val.toLowerCase()];
        const count = /^(\d+)\s*([hdwmy])$/i.exec(val);
        if (word) filters.lastMs = word;
        else if (count) filters.lastMs = Number(count[1]) * LAST_UNITS[count[2].toLowerCase()];
        else words.push(tok); // not a duration: search it as text
        continue;
      }
      case 'from': {
        const who = val.toLowerCase().split(',').map((s) => s.trim()).filter((s): s is SearchWho => WHO.has(s as SearchWho));
        if (who.length > 0) filters.from = [...new Set([...(filters.from ?? []), ...who])];
        else words.push(tok);
        continue;
      }
      case 'tool':
        if (val) filters.tool = tagWords(val); else filters.from = [...new Set([...(filters.from ?? []), 'tool' as const])];
        continue;
      case 'agent':
        if (val.toLowerCase() === 'claude' || val.toLowerCase() === 'codex') filters.agent = val.toLowerCase() as 'claude' | 'codex';
        else words.push(tok);
        continue;
      case 'in': {
        const v = val.toLowerCase();
        if (v === 'archive' || v === 'archived' || v === 'closed') filters.in = 'archive';
        else if (v === 'open') filters.in = 'open';
        else if (v === 'all') filters.in = 'all';
        else words.push(tok);
        continue;
      }
      case 'chat': {
        if (/^chat_[a-z0-9]+$/i.test(val)) { filters.chatId = val; continue; }
        const parts = tagWords(val);
        if (parts.length > 0) filters.chat = parts; else words.push(tok);
        continue;
      }
      case 'repo':
        if (val) filters.repo = val; else words.push(tok);
        continue;
      default:
        words.push(tok);
    }
  }
  return {
    text: words.join(' ').trim(),
    filters,
    hasFilters: Object.keys(filters).length > 0,
  };
}

/** What a search covers when no `from:` is given: the conversation —
 *  not tool calls and their output, which are most of the bytes and
 *  rarely what someone is looking for. */
export const DEFAULT_SEARCH_FROM: SearchWho[] = ['user', 'agent'];

/** The filters with the `from:` default applied: the conversation, or
 *  tool rows when a `tool:` name was asked for. */
export function withSearchDefaults(filters: SearchFilters): SearchFilters {
  if (filters.from && filters.from.length > 0) return filters;
  return { ...filters, from: filters.tool ? ['tool'] : DEFAULT_SEARCH_FROM };
}

/** The tags the Search panel offers as buttons. `value` is what a click
 *  inserts; tags ending in ':' expect the user to type a value. */
export const SEARCH_TAGS = [
  { key: 'ticket', value: 'ticket:' },
  { key: 'cr', value: 'cr:' },
  { key: 'last', value: 'last:week' },
  { key: 'last', value: 'last:month' },
  { key: 'from', value: 'from:user' },
  { key: 'from', value: 'from:agent' },
  { key: 'from', value: 'from:tool' },
  { key: 'tool', value: 'tool:' },
  { key: 'agent', value: 'agent:codex' },
  { key: 'in', value: 'in:archive' },
  { key: 'chat', value: 'chat:' },
] as const;
