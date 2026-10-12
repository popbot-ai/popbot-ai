import { describe, expect, it } from 'vitest';
import { Mailbox, MemoryMailStore, type MailDelivery, type MailNotice } from './mailbox';

function setup() {
  let now = 1_000_000;
  const told: Array<{ chatId: string; notice: MailNotice }> = [];
  const turnStarts = new Map<string, number>();
  const names: Record<string, string> = { boss: 'FREDDY', worker: 'Jim', other: 'Other' };
  const delivery: MailDelivery = {
    notify: async (chatId, notice) => {
      told.push({ chatId, notice });
      return true;
    },
    lastTurnStartAt: (chatId) => turnStarts.get(chatId) ?? 0,
    canReceive: (chatId) => chatId in names,
    chatName: (chatId) => names[chatId] ?? null,
    // The user made boss the manager of worker; other is linked to nobody.
    relation: (from, to) => (from === 'boss' && to === 'worker' ? 'worker' : from === 'worker' && to === 'boss' ? 'manager' : null),
  };
  const store = new MemoryMailStore();
  const mailbox = new Mailbox(store, delivery, { now: () => now });
  return {
    mailbox,
    told,
    later: (ms: number) => { now += ms; },
    turnStarted: (chatId: string) => turnStarts.set(chatId, now),
  };
}

describe('agent mailboxes', () => {
  it('interrupts the target at once — with the summary, never the text', async () => {
    const t = setup();
    const m = await t.mailbox.send({ to: 'worker', from: 'boss', summary: 'Use the other branch', body: 'The long reason why…' });
    expect(m.interrupted).toBe(true);
    expect(t.told).toHaveLength(1);
    expect(t.told[0].chatId).toBe('worker');
    expect(t.told[0].notice.text).toBe(`FREDDY sent you a message: Use the other branch (popbot read_message ${m.id}; answer with popbot reply)`);
    expect(t.told[0].notice.text).not.toContain('long reason');
    // It still has to ask for the text.
    expect(t.mailbox.read('worker', m.id).body).toBe('The long reason why…');
  });

  it('a summary can be the whole message', async () => {
    const t = setup();
    const m = await t.mailbox.send({ to: 'worker', from: 'boss', summary: 'Can you send me the zip with all your work?' });
    expect(m.body).toBeNull();
    expect(t.told[0].notice.text).toContain('nothing more to read');
    expect(t.mailbox.list('worker')[0]).toMatchObject({ summary: 'Can you send me the zip with all your work?' });
  });

  it('keeps summaries to one line of at most 50 characters', async () => {
    const t = setup();
    const m = await t.mailbox.send({ to: 'worker', from: 'boss', summary: `a\nb ${'x'.repeat(80)}` });
    expect(m.summary.length).toBe(50);
    expect(m.summary).not.toContain('\n');
  });

  it('does not interrupt the sender with replies — or with anything its target sends it', async () => {
    const t = setup();
    const asked = await t.mailbox.send({ to: 'worker', from: 'boss', summary: 'Do you have build.log?' });
    t.told.length = 0;
    t.mailbox.reply({ messageId: asked.id, from: 'worker', summary: 'Yes, sending it' });
    // A worker writing to its manager on its own writes mail: its inbox.
    t.mailbox.mail({ to: 'boss', from: 'worker', summary: 'Found another bug' });
    expect(t.told).toHaveLength(0);
    expect(t.mailbox.list('boss').map((m) => m.summary).sort()).toEqual(['Found another bug', 'Yes, sending it']);
  });

  it('tells the sender only how many wait — after 30s, then each minute, warning before they expire', async () => {
    const t = setup();
    const asked = await t.mailbox.send({ to: 'worker', from: 'boss', summary: 'Q1' });
    t.mailbox.reply({ messageId: asked.id, from: 'worker', summary: 'A1' });
    t.told.length = 0;
    const boss = (): string[] => t.told.filter((x) => x.chatId === 'boss').map((x) => x.notice.text);

    t.later(20_000);
    await t.mailbox.tick();
    expect(boss()).toEqual([]);

    t.later(15_000);
    await t.mailbox.tick();
    expect(boss()).toEqual(['[PopBot, not from the user] You have 1 response waiting in your inbox. Read it with the popbot tool list_mailbox when convenient.']);

    // Busy: the notice has not been taken up yet, so no second one stacks.
    t.later(65_000);
    await t.mailbox.tick();
    expect(boss()).toHaveLength(1);

    // Taken up, a minute on, still unread.
    t.turnStarted('boss');
    t.later(10_000);
    await t.mailbox.tick();
    expect(boss().at(-1)).toBe('[PopBot, not from the user] You still have 1 response waiting in your inbox. Read it with the popbot tool list_mailbox when convenient.');

    // Three minutes in: about to expire.
    t.turnStarted('boss');
    t.later(80_000);
    await t.mailbox.tick();
    expect(boss().at(-1)).toBe('[PopBot, not from the user] You still have 1 response waiting in your inbox, 1 msg is about to expire. Read it with the popbot tool list_mailbox when convenient.');

    // Five minutes: gone, and nothing more said.
    t.turnStarted('boss');
    t.later(120_000);
    await t.mailbox.tick();
    expect(t.mailbox.list('boss')).toEqual([]);
    const told = boss().length;
    t.later(60_000);
    await t.mailbox.tick();
    expect(boss()).toHaveLength(told);
  });

  it('says message, not response, when it is not all answers', async () => {
    const t = setup();
    t.mailbox.post({ to: 'boss', from: null, summary: 'build.log arrived' });
    t.later(31_000);
    await t.mailbox.tick();
    expect(t.told.at(-1)?.notice.text).toBe('[PopBot, not from the user] You have 1 message waiting in your inbox. Read it with the popbot tool list_mailbox when convenient.');
  });

  it('lets only a manager message its workers — everyone else writes mail', async () => {
    const t = setup();
    await expect(t.mailbox.send({ to: 'boss', from: 'worker', summary: 'FYI' })).rejects.toThrow(/only a manager can message its workers.*send_mail/);
    await expect(t.mailbox.send({ to: 'worker', from: 'other', summary: 'hi' })).rejects.toThrow(/only a manager/);
    expect((await t.mailbox.send({ to: 'worker', from: 'boss', summary: 'Q' })).interrupted).toBe(true);
  });

  it('lets any chat mail any other — into its inbox, never interrupting, told by count', async () => {
    const t = setup();
    t.mailbox.mail({ to: 'worker', from: 'other', summary: 'FYI: new logo is in' });
    t.mailbox.mail({ to: 'worker', from: 'boss', summary: 'Mail, not a message' });
    expect(t.told).toEqual([]);
    t.later(31_000);
    await t.mailbox.tick();
    expect(t.told.map((x) => x.notice.text)).toEqual(['[PopBot, not from the user] You have 2 messages waiting in your inbox. Read them with the popbot tool list_mailbox when convenient.']);
    expect(() => t.mailbox.mail({ to: 'nobody', from: 'other', summary: 'x' })).toThrow(/no chat nobody/);
  });

  it('stops once everything is read or deleted', async () => {
    const t = setup();
    const a = t.mailbox.post({ to: 'boss', from: 'worker', summary: 'one' });
    const b = t.mailbox.post({ to: 'boss', from: 'worker', summary: 'two' });
    t.mailbox.read('boss', a.id);
    t.mailbox.delete('boss', [b.id]);
    t.later(120_000);
    await t.mailbox.tick();
    expect(t.told).toHaveLength(0);
    expect(t.mailbox.list('boss').map((m) => m.id)).toEqual([a.id]);
  });

  it('keeps each mailbox its own', async () => {
    const t = setup();
    const m = await t.mailbox.send({ to: 'worker', from: 'boss', summary: 'private' });
    expect(() => t.mailbox.read('other', m.id)).toThrow(/no message/);
    expect(() => t.mailbox.reply({ messageId: m.id, from: 'other', summary: 'x' })).toThrow(/no message/);
    expect(t.mailbox.delete('other', [m.id])).toEqual({ deleted: [], missing: [m.id] });
  });
});
