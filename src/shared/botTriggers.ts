/**
 * The words a bot's triggers send it. Shared so the host sends exactly
 * what the bot form shows as an example.
 */
import type { BotTrigger, CronTrigger, GithubTrigger } from './hostProtocol';

/** Who last put any of `labels` on a pull request, from its labeling
 *  events (oldest first) — what the wake says asked for the bot. */
export function labeledBy(labels: string[], events: Array<{ label: string; actor: string }>): string | null {
  const watched = new Set(labels.map((l) => l.toLowerCase()));
  let last: string | null = null;
  for (const e of events) if (e.actor && watched.has(e.label.toLowerCase())) last = e.actor;
  return last;
}

/** One pull request's line in a GitHub wake. */
export function githubWakeLine(
  pr: { number: number; title: string; author: string; draft: boolean; url: string; labeledBy?: string | null },
  changes: string[],
): string {
  const by = pr.labeledBy && pr.labeledBy.toLowerCase() !== pr.author.toLowerCase() ? `, labeled by @${pr.labeledBy}` : '';
  return `- PR #${pr.number} "${pr.title}" by @${pr.author}${by}${pr.draft ? ' (draft)' : ''} — ${changes.join('; ')}\n  ${pr.url}`;
}

export function githubWakeText(repo: string, trigger: Pick<GithubTrigger, 'labels'>, lines: string[], gone: string[]): string {
  return (
    `GitHub — ${repo}, open pull requests labeled ${trigger.labels.join(' or ')}:\n\n${lines.join('\n')}` +
    (gone.length ? `\n\nNo longer open, or no longer labeled: ${gone.map((n) => `#${n}`).join(', ')}.` : '')
  );
}

export function cronWakeText(trigger: Pick<CronTrigger, 'schedule' | 'message'>): string {
  return `Scheduled (${trigger.schedule}):\n\n${trigger.message.trim() || 'Your scheduled check.'}`;
}

/** What a trigger would send, with made-up pull requests — for the form. */
export function exampleWakeText(trigger: BotTrigger, fallbackRepo: string | null): string {
  if (trigger.kind === 'cron') return cronWakeText(trigger);
  const repo = trigger.repo || fallbackRepo || 'owner/repo';
  const labels = trigger.labels.length ? trigger.labels : ['your-label'];
  const url = (n: number): string => `https://github.com/${repo}/pull/${n}`;
  return githubWakeText(repo, { labels }, [
    githubWakeLine({ number: 1234, title: 'Fix the nav on mobile', author: 'alice', draft: false, url: url(1234) }, ['new commits — head 1a2b3c4, was 9f8e7d6', 'CI failure']),
    githubWakeLine({ number: 1240, title: 'Add the pricing page', author: 'bob', draft: false, url: url(1240) }, ['new to you']),
  ], ['1229']);
}
