import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { SourceControlProviderId } from '@shared/sourceControl';
import {
  getReviewByNumber,
  listPendingReviews,
  listPendingReviewsFor,
  listRecentOpenPrs,
  reviewProviders,
} from '../reviews';

export function registerReviewsHandlers(): void {
  ipcMain.handle(IpcChannel.ReviewsList, () => listPendingReviews());
  ipcMain.handle(IpcChannel.ReviewsProviders, () => reviewProviders());
  ipcMain.handle(IpcChannel.ReviewsListFor, (_e, scm: SourceControlProviderId) =>
    listPendingReviewsFor(scm),
  );
  ipcMain.handle(IpcChannel.ReviewsGetPr, (_e, prNumber: number, scm?: SourceControlProviderId) =>
    getReviewByNumber(prNumber, scm),
  );
  ipcMain.handle(IpcChannel.ReviewsListRecent, () => listRecentOpenPrs());
}
