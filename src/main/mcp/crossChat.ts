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
  from: { id: string; name: string },
  waiting: boolean,
): string {
  const how = waiting
    ? 'That chat is waiting for this turn to finish: reply as you normally would, and your reply is delivered to it.'
    : `That chat is not waiting for a reply. To answer it, use the popbot tool send_to_chat with chatId "${from.id}".`;
  return (
    `Message from the agent in PopBot chat "${from.name}" (chat id ${from.id}) — not from the user of this chat. ${how}\n\n` +
    text
  );
}
