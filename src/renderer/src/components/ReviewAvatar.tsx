import { useEffect, useState } from 'react';
import type { SourceControlProviderId } from '@shared/sourceControl';
import { authorInitials, reviewAvatarUrl } from '@shared/reviews';

/**
 * The round mark of a review chat: the PR author's avatar where the
 * repo dot would be, so a review is found by the face of the person
 * it is for. GitHub serves an avatar for any login; a Swarm review, or
 * an image that fails to load, falls back to initials on the repo
 * color. Callers pass the class of the mark it replaces so it keeps
 * that mark's size, status colouring and animation.
 */
export function ReviewAvatar({
  author,
  scm,
  className,
  title,
}: {
  author: string;
  scm?: SourceControlProviderId | null;
  className: string;
  title?: string;
}): JSX.Element {
  const url = reviewAvatarUrl(scm, author);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const showImage = !!url && !failed;
  return (
    <span className={`${className} review-avatar${showImage ? ' has-image' : ''}`} title={title ?? author}>
      {showImage ? (
        <img src={url} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="review-avatar-initials">{authorInitials(author)}</span>
      )}
    </span>
  );
}
