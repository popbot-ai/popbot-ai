import { describe, it, expect } from 'vitest';
import { isNodeModulesBin } from './resolveCli';

// Guards the agent-probe fix: a dependency's CLI shim under
// node_modules/.bin must NOT be treated as a user-installed agent.
describe('isNodeModulesBin', () => {
  it('matches paths inside node_modules/.bin (posix + windows)', () => {
    expect(isNodeModulesBin('/home/u/proj/node_modules/.bin')).toBe(true);
    expect(isNodeModulesBin('/home/u/proj/node_modules/.bin/codex')).toBe(true);
    expect(isNodeModulesBin('C:\\proj\\node_modules\\.bin\\codex.cmd')).toBe(true);
    // nested workspace package
    expect(isNodeModulesBin('/home/u/proj/packages/x/node_modules/.bin/foo')).toBe(true);
  });

  it('does not match real install locations', () => {
    expect(isNodeModulesBin('/usr/local/bin/claude')).toBe(false);
    expect(isNodeModulesBin('/home/u/.local/bin/codex')).toBe(false);
    expect(isNodeModulesBin('C:\\Users\\u\\.local\\bin\\claude.exe')).toBe(false);
    // a directory merely named like it, not an actual node_modules/.bin
    expect(isNodeModulesBin('/home/u/node_modules_backup/.bin')).toBe(false);
  });
});
