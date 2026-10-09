import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, upsertBot, writeConfig, type HostConfig } from './config';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { config: HostConfig; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'popbot-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  const config = { ...defaultConfig(), workspacesDir: join(dir, 'ws') };
  upsertBot(config, path, null, {
    name: 'Reviewer',
    triggers: [{ id: 't1', kind: 'github', repo: 'org/site', labels: ['review'], pollSeconds: 30 }],
  });
  // A field this build does not know, as a newer desktop would have saved it.
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.bots[0].triggers[0].newerField = 'set';
  writeFileSync(path, JSON.stringify(raw));
  return { config: loadConfig(path), path };
}

describe("a bot's settings survive builds that don't know them", () => {
  it('keeps a trigger’s field when a save leaves it out — a desktop older than the field', () => {
    const { config, path } = setup();
    // What a desktop from before the field sends: the trigger without it.
    const older = { id: 't1', kind: 'github', repo: 'org/site', labels: ['review', 'ship'], pollSeconds: 30 };
    const bot = upsertBot(config, path, 'reviewer', { name: 'Reviewer', triggers: [older as never] });
    expect(bot.triggers[0]).toMatchObject({ newerField: 'set', labels: ['review', 'ship'] });
  });

  it('still clears it when a save says so', () => {
    const { config, path } = setup();
    const bot = upsertBot(config, path, 'reviewer', {
      name: 'Reviewer',
      triggers: [{ id: 't1', kind: 'github', repo: 'org/site', labels: ['review'], pollSeconds: 30, newerField: '' } as never],
    });
    expect(bot.triggers[0]).toMatchObject({ newerField: '' });
  });

  it('keeps fields it does not know through a load and a save — a host older than them', () => {
    const { config, path } = setup();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.bots[0].futureBotField = { x: 1 };
    raw.bots[0].triggers[0].futureTriggerField = 'kept';
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadConfig(path);
    writeConfig(path, loaded);
    const again = JSON.parse(readFileSync(path, 'utf8'));
    expect(again.bots[0].futureBotField).toEqual({ x: 1 });
    expect(again.bots[0].triggers[0]).toMatchObject({ futureTriggerField: 'kept', newerField: 'set' });
    expect(config.bots).toHaveLength(1);
  });
});
