/**
 * "Go to this message" across the app. The Search panel asks for a jump,
 * App focuses (or reopens) the chat, and the chat's transcript picks the
 * request up whenever it is ready — on mount, when the event fires, or
 * once its messages have loaded — then scrolls the row into view and
 * flashes it. A pending request outlives a column that isn't mounted yet.
 */
const pending = new Map<string, string>();

export const JUMP_EVENT = 'popbot:jump-to-message';

export function requestJump(chatId: string, messageId: string): void {
  pending.set(chatId, messageId);
  window.dispatchEvent(new CustomEvent(JUMP_EVENT, { detail: { chatId } }));
}

export function peekJump(chatId: string): string | null {
  return pending.get(chatId) ?? null;
}

export function clearJump(chatId: string): void {
  pending.delete(chatId);
}
