import { describe, expect, it } from 'vitest';
import {
  UNREAL_MCP_DEFAULT_BASE_PORT,
  unrealMcpIniArg,
  unrealMcpPort,
} from './gameEngine';

describe('unrealMcpPort', () => {
  it('slot 1 uses the base port exactly', () => {
    expect(unrealMcpPort(8001, 1)).toBe(8001);
  });

  it('each later slot adds one', () => {
    expect(unrealMcpPort(8001, 2)).toBe(8002);
    expect(unrealMcpPort(8001, 3)).toBe(8003);
    expect(unrealMcpPort(8001, 10)).toBe(8010);
  });

  it('honours a non-default base port', () => {
    expect(unrealMcpPort(9000, 1)).toBe(9000);
    expect(unrealMcpPort(9000, 4)).toBe(9003);
  });

  it('falls back to slot 1 for a missing/invalid slot', () => {
    // No chat/slot resolvable → the base port (never a negative offset).
    expect(unrealMcpPort(8001, null)).toBe(8001);
    expect(unrealMcpPort(8001, undefined)).toBe(8001);
    expect(unrealMcpPort(8001, 0)).toBe(8001);
    expect(unrealMcpPort(8001, -5)).toBe(8001);
  });

  it('has a default base of 8001', () => {
    expect(UNREAL_MCP_DEFAULT_BASE_PORT).toBe(8001);
    expect(unrealMcpPort(UNREAL_MCP_DEFAULT_BASE_PORT, 1)).toBe(8001);
  });
});

describe('unrealMcpIniArg', () => {
  it('produces the exact -ini: override Unreal expects', () => {
    expect(unrealMcpIniArg(8001)).toBe(
      '-ini:Engine:[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]:ServerPortNumber=8001',
    );
  });

  it('embeds the given port', () => {
    expect(unrealMcpIniArg(8003)).toContain('ServerPortNumber=8003');
  });
});
