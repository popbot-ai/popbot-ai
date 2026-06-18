/**
 * Minimal Slack Web API client. Hand-rolled fetch (no SDK) — we only
 * touch a handful of endpoints, and a thin surface keeps it auditable
 * for users who care that their messages stay on Slack's side.
 *
 * All requests go to `https://slack.com/api/` with the user's xoxp-
 * token in the Authorization header. Response shapes only include
 * the fields PopBot reads.
 */

const API = 'https://slack.com/api';

export class SlackAuthError extends Error {
  constructor(message = 'Slack token rejected') {
    super(message);
    this.name = 'SlackAuthError';
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
}

async function call<T extends SlackResponse>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API}/${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const json = (await res.json()) as T;
  if (!json.ok) {
    if (json.error === 'invalid_auth' || json.error === 'token_expired' || json.error === 'not_authed') {
      throw new SlackAuthError(json.error);
    }
    throw new Error(`Slack API: ${json.error ?? 'unknown_error'}`);
  }
  return json;
}

interface AuthTest extends SlackResponse {
  user: string;
  user_id: string;
  team: string;
  team_id: string;
  url: string;
}

/** Verify a token + return identity. Used by the prefs Test button. */
export async function authTest(token: string): Promise<AuthTest> {
  return call<AuthTest>('auth.test', token);
}

interface ConversationsList extends SlackResponse {
  channels: Array<{
    id: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_user_deleted?: boolean;
    user?: string;        // counterpart user id for IMs
    name?: string;        // for mpim — comma-separated names
  }>;
  response_metadata?: { next_cursor?: string };
}

/** List the user's open DM (im) and group-DM (mpim) channels. */
export async function listDmChannels(token: string): Promise<ConversationsList['channels']> {
  const out: ConversationsList['channels'] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const params: Record<string, string> = {
      types: 'im,mpim',
      limit: '100',
      exclude_archived: 'true',
    };
    if (cursor) params.cursor = cursor;
    const r = await call<ConversationsList>('users.conversations', token, params);
    out.push(...r.channels);
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

interface ConversationsInfo extends SlackResponse {
  channel: {
    id: string;
    last_read?: string;          // ts of last-read message
    unread_count_display?: number;
    user?: string;
  };
}

export async function channelInfo(token: string, channel: string): Promise<ConversationsInfo['channel']> {
  const r = await call<ConversationsInfo>('conversations.info', token, { channel });
  return r.channel;
}

export interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  /** Permalink fetched separately. */
  permalink?: string;
}

interface ConversationsHistory extends SlackResponse {
  messages: SlackMessage[];
}

/** Messages newer than `oldest` (ts string). */
export async function channelHistory(token: string, channel: string, oldest: string, limit = 20): Promise<SlackMessage[]> {
  const r = await call<ConversationsHistory>('conversations.history', token, {
    channel, oldest, limit: String(limit),
    inclusive: 'false',
  });
  return r.messages;
}

interface UsersInfo extends SlackResponse {
  user: {
    id: string;
    real_name?: string;
    profile?: { display_name?: string; real_name?: string };
  };
}

const userCache = new Map<string, { name: string; cachedAt: number }>();

/** Fetch a user's display name (cached for 1h). */
export async function userName(token: string, userId: string): Promise<string> {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.cachedAt < 60 * 60_000) return hit.name;
  try {
    const r = await call<UsersInfo>('users.info', token, { user: userId });
    const name = r.user.profile?.display_name?.trim()
      || r.user.profile?.real_name?.trim()
      || r.user.real_name?.trim()
      || userId;
    userCache.set(userId, { name, cachedAt: Date.now() });
    return name;
  } catch {
    return userId;
  }
}

interface SearchMessages extends SlackResponse {
  messages: {
    matches: Array<{
      type: string;
      ts: string;
      user?: string;
      username?: string;
      text: string;
      channel: { id: string; name?: string; is_channel?: boolean; is_private?: boolean };
      permalink: string;
    }>;
  };
}

/** Find messages mentioning the user. Sorted newest first. */
export async function searchMentions(token: string, userId: string, sinceMs: number): Promise<SearchMessages['messages']['matches']> {
  // Slack search syntax — `@U123` won't match; need `<@U123>` or the
  // username, but search-text matches "<@U123>" embedded in messages.
  // The user-id wrapped form is the most reliable. `after:` takes a
  // YYYY-MM-DD date so we filter in the poller for fine-grained ts.
  const date = new Date(sinceMs);
  const isoDate = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  const r = await call<SearchMessages>('search.messages', token, {
    query: `<@${userId}> after:${isoDate}`,
    sort: 'timestamp',
    sort_dir: 'desc',
    count: '20',
  });
  return r.messages.matches;
}

interface Permalink extends SlackResponse {
  permalink: string;
}

export async function messagePermalink(token: string, channel: string, ts: string): Promise<string | null> {
  try {
    const r = await call<Permalink>('chat.getPermalink', token, { channel, message_ts: ts });
    return r.permalink;
  } catch {
    return null;
  }
}
