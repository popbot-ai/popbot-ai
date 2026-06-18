/**
 * Best-effort non-LLM classifier for notification text. Heuristic only —
 * keyword + regex rules covering the most common cases (bugs, PR-related
 * traffic, @mentions, deploys). Inputs are short notification titles +
 * a snippet, not full bodies; this is meant to enrich incoming items
 * with a category tag and possibly bump priority, not to deeply parse.
 *
 * Free of state — call from anywhere, including before notify(). The
 * caller decides whether to use the suggestion (e.g. Sentry already
 * has an authoritative level and may ignore the bug-ness inference).
 */

export type Category =
  | 'blocker'    // release blocker, P0, must-fix-before-ship
  | 'bug'        // exception/crash/repro
  | 'pr'         // PR-related (review request, mergeable, etc.)
  | 'mention'    // @-mention of the user
  | 'deploy'     // deploys / releases / rollouts
  | 'review'     // code review feedback / review request
  | 'question'   // someone asking the user something
  | 'info';      // generic / unclassified

export interface Classified {
  category: Category;
  /** Suggested priority bump — caller decides whether to apply. */
  prioritySuggestion?: 'silent' | 'info' | 'normal' | 'urgent';
  /** Free-form tags pulled out of the text — usernames, ticket ids,
   *  PR numbers, error class names. UI may render them as chips. */
  tags: string[];
  /** True when the sender (when supplied to classify) matched one of
   *  the configured VIP names. Caller can use this to bump priority
   *  + visually mark the notification. */
  isVip?: boolean;
}

export interface ClassifyOptions {
  /** Display name of the message sender, used for VIP matching. */
  senderName?: string;
  /** List of VIP name fragments — matched case-insensitively as
   *  substrings of `senderName`. "York" matches "Yorktown" too — keep
   *  the list specific. */
  vips?: string[];
}

// Each pattern below is intentionally a flat alternation list so it's
// trivial to add new vocabulary without restructuring. The cost of
// SonarLint's "complexity" is justified by the readability win for
// the next person tweaking these.

// Release blockers / P0 / urgency words — highest urgency.
const RX_BLOCKER = new RegExp(
  '\\b(' + [
    'blocker', 'release\\s*blocker', 'hard\\s*blocker', 'soft\\s*blocker',
    'blocking\\s+(the\\s+)?(release|build|ship|deploy|launch|merge)',
    'blocks?\\s+(the\\s+)?(release|build|ship|deploy|launch|merge)',
    'p0\\b', 'sev\\s*[01]\\b',
    'production\\s+down', 'prod\\s+down', 'site\\s+down',
    'must[-\\s]?fix', 'must[-\\s]?have', 'stop[-\\s]?ship',
    'asap\\b', 'urgent\\b', 'immediately\\b',
    'fire\\s+drill', 'all[-\\s]?hands',
    'rollback\\b', 'reverted?\\b',
  ].join('|') + ')\\b',
  'i',
);

// Bugs / crashes / repro / build failures + crash-tracking platforms.
const RX_BUG = new RegExp(
  '\\b(' + [
    'error', 'exception', 'crash(ed|ing)?',
    'traceback', 'stack\\s*trace',
    'undefined', 'null\\s*pointer', 'cannot\\s+read',
    'TypeError', 'ReferenceError',
    'out\\s+of\\s+memory', 'OOM', 'ANR',
    'segfault', 'panic', 'fatal',
    'soft[-\\s]?lock', 'hard[-\\s]?lock',
    'freeze(s|d|ing)?', 'hung?', 'hangs?',
    'regression', 'regressed', 'broke(n)?',
    'repro(duce(s|d)?)?', 'reproducible',
    'broken\\s+build', 'build\\s+(failure|broken|red)',
    'CI\\s+(failing|red|broken)', 'tests?\\s+(failing|red|broken)',
    'QA\\s+(failed|blocking)',
    'unity\\s+error', 'asset\\s+pipeline',
    // Crash-tracking platforms — mention of one usually means a bug.
    'sentry', 'bugsee', 'crashlytics', 'firebase\\s+crashlytics',
    'datadog\\s+(error|alert)', 'rollbar', 'pagerduty',
  ].join('|') + ')\\b',
  'i',
);

// PR-related verbiage.
const RX_PR = new RegExp(
  '\\b(' + [
    'pull\\s*request', 'merge\\s*request',
    'PR\\s*#?\\d+',
    'merge\\s*conflict', 'rebase\\s+needed',
    'merged', 'ready\\s+to\\s+merge', 'ready\\s+for\\s+merge',
    'auto[-\\s]?merge',
  ].join('|') + ')\\b',
  'i',
);

const RX_REVIEW = new RegExp(
  '\\b(' + [
    'review\\s*request', 'requesting\\s+review',
    'please\\s+review', 'needs?\\s+(review|eyes)',
    'code\\s*review', 'CR\\s+(needed|please)',
    're-?request(ed|ing)?',
  ].join('|') + ')\\b',
  'i',
);

const RX_DEPLOY = new RegExp(
  '\\b(' + [
    'deploy(ed|ing|ment)?', 'release(d)?', 'shipping',
    'rollout', 'hotfix', 'patch\\s+release',
    'cut\\s*a\\s*build', 'tag(ged)?\\s+rc-?\\d+',
    'rc-?\\d+\\.\\d+',
    'code\\s+freeze', 'feature\\s+freeze',
  ].join('|') + ')\\b',
  'i',
);

const RX_QUESTION = /\?\s*$|\bcan\s+you\b|\bcould\s+you\b|\bwhat'?s\b|\bany\s+(idea|chance|reason)|\bhave\s+you\s+seen\b|\bdo\s+you\s+know\b/i;

// Identifiers — extracted as tags. URL forms checked first, then bare ids.
const RX_MENTION = /(?:^|\s)@([a-zA-Z0-9_.\-]+)/g;
// Linear: digits-only after dash (ENG-1234, ART-987).
const RX_TICKET = /\b([A-Z]{2,}-\d+)\b/g;
const RX_LINEAR_URL = /linear\.app\/[^/\s]+\/issue\/([A-Z]{2,}-\d+)/gi;
// Sentry shortID: at least one letter after the dash (POP-1A, JS-3F4).
// Distinct from Linear because Sentry uses base32-ish IDs.
const RX_SENTRY_SHORT = /\b([A-Z]+-(?=[0-9A-Z]*[A-Z])[0-9A-Z]+)\b/g;
const RX_SENTRY_URL = /sentry\.io\/(?:organizations\/[^/\s]+\/)?issues\/([0-9A-Z-]+)/gi;
// Bugsee URLs (mobile crash reporting): app.bugsee.com/.../issues/{id}
const RX_BUGSEE_URL = /bugsee\.com\/[^\s]*?\/(?:issues|bugs|crashes)\/([A-Za-z0-9-]+)/gi;
const RX_RC_TAG = /\b(rc-?\d+(?:\.\d+){1,2})\b/gi;
const RX_PR_NUM = /\b(?:PR\s*#|pull\/|#)(\d{2,})\b/gi;
const RX_PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/gi;
const RX_ERROR_CLASS = /\b([A-Z][a-zA-Z]+(?:Error|Exception))\b/g;

function collect(rx: RegExp, text: string, group = 1): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  rx.lastIndex = 0;
  while ((m = rx.exec(text)) !== null) {
    if (m[group]) out.add(m[group]);
  }
  return [...out];
}

export function classify(text: string, opts?: ClassifyOptions): Classified {
  const t = text || '';
  // VIP check — sender's display name matched against the configured
  // VIP list (case-insensitive substring). VIPs always bump priority
  // to urgent regardless of message content.
  const senderLower = (opts?.senderName ?? '').toLowerCase();
  const isVip = !!senderLower && (opts?.vips ?? []).some((v) => {
    const trimmed = v.trim().toLowerCase();
    return trimmed.length > 0 && senderLower.includes(trimmed);
  });
  const tags: string[] = [
    ...collect(RX_MENTION, t),
    // Extract from URL form first so we get the id even if the bare
    // form isn't repeated; then bare form picks up anything else.
    ...collect(RX_LINEAR_URL, t),
    ...collect(RX_TICKET, t),
    ...collect(RX_SENTRY_URL, t),
    ...collect(RX_SENTRY_SHORT, t),
    ...collect(RX_BUGSEE_URL, t),
    ...collect(RX_RC_TAG, t),
    ...collect(RX_PR_URL, t),
    ...collect(RX_PR_NUM, t),
    ...collect(RX_ERROR_CLASS, t),
  ];
  // Dedup while preserving insertion order (URL-derived id wins over
  // bare-id duplicate).
  const dedup = [...new Set(tags)];
  // VIP overrides content — even a casual "hey" from a VIP gets
  // urgent because that's the whole point of the VIP list.
  if (isVip) {
    return { category: 'mention', prioritySuggestion: 'urgent', tags: dedup, isVip };
  }
  // Order matters — most-urgent signal wins. Blocker > bug > review/pr
  // > deploy > mention > question > info. A bug-y mention reads as a
  // bug, a release-blocker question reads as a blocker, etc.
  if (RX_BLOCKER.test(t)) {
    return { category: 'blocker', prioritySuggestion: 'urgent', tags: dedup, isVip };
  }
  if (RX_BUG.test(t)) {
    return { category: 'bug', prioritySuggestion: 'urgent', tags: dedup, isVip };
  }
  if (RX_REVIEW.test(t) || RX_PR.test(t)) {
    return { category: 'pr', prioritySuggestion: 'normal', tags: dedup, isVip };
  }
  if (RX_DEPLOY.test(t)) {
    return { category: 'deploy', prioritySuggestion: 'normal', tags: dedup, isVip };
  }
  if (collect(RX_MENTION, t).length > 0) {
    return { category: 'mention', prioritySuggestion: 'normal', tags: dedup, isVip };
  }
  if (RX_QUESTION.test(t)) {
    return { category: 'question', prioritySuggestion: 'normal', tags: dedup, isVip };
  }
  return { category: 'info', prioritySuggestion: 'info', tags: dedup, isVip };
}
