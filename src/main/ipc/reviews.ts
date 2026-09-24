import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { GetReviewResult, ListReviewsResult, ReviewItem } from '@shared/reviews';
import type { SourceControlProviderId } from '@shared/sourceControl';
import { AgentHost } from '../agents/AgentHost';
import { dlog } from '../diagLog';
import { getChat, listClosedChats, listOpenChats, setChatPrAuthor } from '../persistence/chats';
import { isDbOpen } from '../persistence/db';
import {
  getReviewByNumber,
  listPendingReviews,
  listPendingReviewsFor,
  listRecentOpenPrs,
  reviewProviders,
} from '../reviews';

/**
 * Review chats created before the PR author was stored: whenever the
 * review queue comes back, any such chat whose PR is in it gets its
 * author filled in, so its avatar appears without a re-creation. The
 * match is by number within the review system (Swarm ids and PR
 * numbers can collide, so a Swarm review only fills Perforce chats).
 */
function backfillReviewAuthors(reviews: ReviewItem[]): void {
  if (!isDbOpen() || reviews.length === 0) return;
  const byKey = new Map<string, string>();
  for (const r of reviews) {
    if (r.author) byKey.set(`${r.scm === 'swarm' ? 'perforce' : 'git'}:${r.number}`, r.author);
  }
  for (const chat of [...listOpenChats(), ...listClosedChats()]) {
    if (chat.pr == null || chat.prAuthor) continue;
    const author = byKey.get(`${chat.repoScm === 'perforce' ? 'perforce' : 'git'}:${chat.pr}`);
    if (!author) continue;
    setChatPrAuthor(chat.id, author);
    dlog('reviews.author-backfilled', { chatId: chat.id, pr: chat.pr, author });
    const fresh = getChat(chat.id);
    if (fresh) AgentHost.emit({ type: 'chat-updated', chatId: chat.id, chat: fresh, ts: Date.now() });
  }
}

async function withBackfill(result: Promise<ListReviewsResult>): Promise<ListReviewsResult> {
  const r = await result;
  if (r.ok) backfillReviewAuthors(r.reviews);
  return r;
}

export function registerReviewsHandlers(): void {
  ipcMain.handle(IpcChannel.ReviewsList, () => withBackfill(listPendingReviews()));
  ipcMain.handle(IpcChannel.ReviewsProviders, () => reviewProviders());
  ipcMain.handle(IpcChannel.ReviewsListFor, (_e, scm: SourceControlProviderId) =>
    withBackfill(listPendingReviewsFor(scm)),
  );
  ipcMain.handle(IpcChannel.ReviewsGetPr, async (_e, prNumber: number, scm?: SourceControlProviderId): Promise<GetReviewResult> => {
    const r = await getReviewByNumber(prNumber, scm);
    if (r.ok) backfillReviewAuthors([r.pr]);
    return r;
  });
  ipcMain.handle(IpcChannel.ReviewsListRecent, () => listRecentOpenPrs());
}
