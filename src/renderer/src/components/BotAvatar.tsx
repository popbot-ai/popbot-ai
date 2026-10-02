/**
 * A bot chat's face: its picture (or a robot) in the round slot where
 * other chats show the repo dot — the column header, the thumbnail
 * card and its stripe, the Bots tab. Like ReviewAvatar, callers pass the
 * class of the mark it replaces, so it keeps that mark's size and its
 * status colouring and pulse.
 */
export function BotAvatar({ avatar, className, title }: {
  avatar: string | null | undefined;
  className: string;
  title?: string;
}): JSX.Element {
  return (
    <span className={`${className} review-avatar bot-mark`} title={title}>
      {avatar ? <img src={avatar} alt="" /> : <i className="fa-solid fa-robot" aria-hidden="true" />}
    </span>
  );
}
