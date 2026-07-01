import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import { getReviewByNumber, listPendingReviews, listRecentOpenPrs } from '../git/reviews';

export function registerReviewsHandlers(): void {
  ipcMain.handle(IpcChannel.ReviewsList, () => listPendingReviews());
  ipcMain.handle(IpcChannel.ReviewsGetPr, (_e, prNumber: number) =>
    getReviewByNumber(prNumber),
  );
  ipcMain.handle(IpcChannel.ReviewsListRecent, () => listRecentOpenPrs());
}
