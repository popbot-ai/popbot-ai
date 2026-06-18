/**
 * Heuristic for "is the agent asking a question / waiting for the user?"
 *
 * Used by AgentHost on message-end to decide whether to flip a chat to
 * `wait`, and by the renderer to pick which agent message gets rendered
 * as a QuestionCard. Keep both sides agreeing on the rule by importing
 * from this single module.
 *
 * Two ways the heuristic can fire:
 *   1. The trimmed text ends with `?`.
 *   2. The trimmed *last sentence* matches one of a small set of common
 *      question stems ("should I…", "do you want me to…", etc.) that
 *      agents often phrase without a trailing `?`.
 *
 * Operate on the LAST sentence so a mid-paragraph rhetorical phrasing
 * doesn't trigger.
 */

const QUESTION_STEMS: readonly RegExp[] = [
  /\bshould i\b/,
  /\bshall i\b/,
  /\bcan i\b/,
  /\bmay i\b/,
  /\bdo you want\b/,
  /\bdo you wish\b/,
  /\bdo you prefer\b/,
  /\bdo you have\b/,
  /\bdo you know\b/,
  /\bwould you like\b/,
  /\bwould you prefer\b/,
  /\bwould you rather\b/,
  /\bwill you\b/,
  /\bare you\b/,
  /\bis this\b/,
  /\bis that\b/,
  /\bare these\b/,
  /\bare those\b/,
  /\byes\s*\/?\s*no\b/,
  /\byes or no\b/,
  // Note: deliberately NOT including "let me know if/whether" — those
  // read as statements inviting feedback, not actual questions; firing
  // wait state on them is too aggressive.
];

export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  if (/[?]\s*$/.test(trimmed)) return true;

  const last = lastSentence(trimmed);
  if (!last) return false;
  return QUESTION_STEMS.some((re) => re.test(last));
}

/**
 * True iff the question reads like a yes/no — its last sentence starts
 * with an auxiliary verb (do/does/is/are/can/should/…) or explicitly
 * mentions "yes/no". Used to decide whether to surface Yes/No quick-
 * reply buttons on the QuestionCard.
 */
const YES_NO_LEADERS = /^(do|does|did|is|are|was|were|can|could|will|would|should|shall|has|have|had|may|might|am)\b/;

export function isYesNoQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const last = lastSentence(trimmed);
  if (!last) return false;
  if (/\byes\s*\/?\s*no\b|\byes or no\b/.test(last)) return true;
  return YES_NO_LEADERS.test(last);
}

function lastSentence(trimmed: string): string {
  const sentences = trimmed
    .split(/[.!\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return sentences[sentences.length - 1]?.toLowerCase() ?? '';
}
