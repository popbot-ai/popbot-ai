/** A message's first sentence, for a cross-chat row with no summary of
 *  its own (sent before summaries were required): one line, cut short. */
export function firstSentence(text: string, max = 120): string {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}
