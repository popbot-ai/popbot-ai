/**
 * A message one chat's agent sends to another through the popbot MCP
 * server arrives in the target chat as a user turn — so without a word
 * of context the receiving agent takes it for its own user's request.
 * This puts the sender in front of it: which chat, by name and id, and
 * how to answer — reply as usual when the sender is waiting on the
 * turn, or message it back with send_to_chat when it is not.
 */
export function attributeCrossChatMessage(
  text: string,
  from: { id: string; name: string; agentName?: string },
  waiting: boolean,
  /** Bots on either end answer through their own tools: a bot with the
   *  bots tool reply_to_chat, a chat answering a bot with message_bot. */
  bots: { toBot?: boolean; fromBotId?: string; replyId?: string } = {},
): string {
  const how = waiting
    ? 'That chat is waiting for this turn to finish: reply as you normally would, and your reply is delivered to it.'
    : bots.toBot
      ? bots.replyId
        ? `That chat is not waiting for a reply. To answer it, use the bots tool reply_to_chat with replyId "${bots.replyId}" (once).`
        : 'That chat is not waiting and cannot be answered: act on it, and say what you did here.'
      : bots.fromBotId
        ? `It is a bot, and it is not waiting for a reply. To answer it, use the popbot tool message_bot with bot "${bots.fromBotId}".`
        : `That chat is not waiting for a reply. To answer it, use the popbot tool send_to_chat with chatId "${from.id}".`;
  return (
    (bots.fromBotId
      ? `Message from the bot "${from.name}" — not from the user of this chat. ${how}\n\n`
      : from.agentName
        ? `Message from ${from.agentName}, the agent in PopBot chat "${from.name}" (chat id ${from.id}) — not from the user of this chat. ${how}\n\n`
        : `Message from the agent in PopBot chat "${from.name}" (chat id ${from.id}) — not from the user of this chat. ${how}\n\n`) +
    text
  );
}
