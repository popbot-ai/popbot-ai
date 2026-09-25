import { describe, expect, it } from 'vitest';
import { attributeCrossChatMessage } from './crossChat';

describe('attributeCrossChatMessage', () => {
  it('names the sending chat and says the sender is waiting', () => {
    const out = attributeCrossChatMessage('Is the build green?', { id: 'chat_abc', name: 'Fix the strip' }, true);
    expect(out.startsWith('Message from the agent in PopBot chat "Fix the strip" (chat id chat_abc)')).toBe(true);
    expect(out).toContain('not from the user of this chat');
    expect(out).toContain('waiting for this turn to finish');
    expect(out.endsWith('\n\nIs the build green?')).toBe(true);
  });

  it('tells a fire-and-forget recipient how to message back', () => {
    const out = attributeCrossChatMessage('FYI, merged.', { id: 'chat_abc', name: 'Fix the strip' }, false);
    expect(out).toContain('not waiting for a reply');
    expect(out).toContain('send_to_chat with chatId "chat_abc"');
  });
});
