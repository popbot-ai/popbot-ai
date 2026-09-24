import { avatarColor } from '../fixtures/data';

/**
 * The round mark of a review chat: the same author circle the Reviews
 * tab draws — the first two characters of the login on the author's
 * hashed colour — where other chats show the repo dot. One look in
 * both lists, so a review is found by the same face in either. Callers
 * pass the class of the mark it replaces so it keeps that mark's size,
 * status colouring and animation.
 */
export function ReviewAvatar({
  author,
  className,
  title,
}: {
  author: string;
  className: string;
  title?: string;
}): JSX.Element {
  const login = author.trim() || '?';
  return (
    <span className={`${className} review-avatar`} style={{ background: avatarColor(login) }} title={title ?? login}>
      {login.slice(0, 2)}
    </span>
  );
}
