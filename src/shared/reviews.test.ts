import { describe, expect, it } from 'vitest';
import { mergePinnedReviews, type ReviewItem } from './reviews';

function item(number: number, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    scm: 'github',
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    author: 'someone',
    headRefName: 'feature',
    baseRefName: 'main',
    isDraft: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    flags: { requestedReviewer: false, noReviewsYet: false, reReview: false },
    ...over,
  };
}

describe('mergePinnedReviews', () => {
  it('keeps the live row’s RE-REVIEW flag when the same PR is also pinned', () => {
    // The pinned copy is fetched by number and used to come back with
    // every flag false; preferring it wholesale hid the re-review.
    const pinned = [item(1)];
    const live = [item(1, { flags: { requestedReviewer: true, noReviewsYet: false, reReview: true } })];
    const [row] = mergePinnedReviews(pinned, live);
    expect(row.flags.reReview).toBe(true);
    expect(row.flags.requestedReviewer).toBe(true);
    expect(row.pinned).toBe(true);
  });

  it('keeps the pin’s RE-REVIEW when only the pinned fetch detected it', () => {
    // Once you review, GitHub drops the team request, so the PR falls out
    // of the queue searches — the pin is the only fetch that still sees it.
    const pinned = [item(2, { flags: { requestedReviewer: false, noReviewsYet: false, reReview: true } })];
    const live = [item(2)];
    expect(mergePinnedReviews(pinned, live)[0].flags.reReview).toBe(true);
  });

  it('leads with pinned rows, follows with live-only rows, and never duplicates', () => {
    const merged = mergePinnedReviews([item(3), item(4)], [item(4), item(5)]);
    expect(merged.map((r) => r.number)).toEqual([3, 4, 5]);
    expect(merged.filter((r) => r.pinned).map((r) => r.number)).toEqual([3, 4]);
  });

  it('carries closed, the later updatedAt, and the later engagement', () => {
    const pinned = [item(6, { closed: true, updatedAt: '2026-09-05T00:00:00Z', engagedAt: 10 })];
    const live = [item(6, { updatedAt: '2026-09-03T00:00:00Z', engagedAt: 20 })];
    const [row] = mergePinnedReviews(pinned, live);
    expect(row.closed).toBe(true);
    expect(row.updatedAt).toBe('2026-09-05T00:00:00Z');
    expect(row.engagedAt).toBe(20);
  });

  it('passes a pin through untouched when the live list lacks it', () => {
    const [row] = mergePinnedReviews([item(7, { tier: 'team' })], []);
    expect(row.pinned).toBe(true);
    expect(row.tier).toBe('team');
  });
});
