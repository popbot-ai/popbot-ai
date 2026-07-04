import { describe, expect, it } from 'vitest';
import {
  MCP_DEFAULT_BASE_PORT,
  mcpDefaultBasePort,
  mcpPortForSlot,
  unityMcpUrlArg,
  unrealMcpIniArg,
} from './gameEngine';

describe('mcpPortForSlot', () => {
  it('slot 1 uses the base port exactly', () => {
    expect(mcpPortForSlot(8001, 1)).toBe(8001);
  });

  it('each later slot adds one', () => {
    expect(mcpPortForSlot(8001, 2)).toBe(8002);
    expect(mcpPortForSlot(8001, 3)).toBe(8003);
    expect(mcpPortForSlot(8001, 10)).toBe(8010);
  });

  it('honours a non-default base port', () => {
    expect(mcpPortForSlot(9000, 1)).toBe(9000);
    expect(mcpPortForSlot(9000, 4)).toBe(9003);
  });

  it('falls back to slot 1 for a missing/invalid slot', () => {
    // No chat/slot resolvable → the base port (never a negative offset).
    expect(mcpPortForSlot(8001, null)).toBe(8001);
    expect(mcpPortForSlot(8001, undefined)).toBe(8001);
    expect(mcpPortForSlot(8001, 0)).toBe(8001);
    expect(mcpPortForSlot(8001, -5)).toBe(8001);
  });

  it('clamps to a valid TCP port at the high end', () => {
    // Base near the ceiling + a high slot must not exceed 65535.
    expect(mcpPortForSlot(65535, 1)).toBe(65535);
    expect(mcpPortForSlot(65535, 4)).toBe(65535);
    expect(mcpPortForSlot(65534, 3)).toBe(65535);
  });
});

describe('mcpDefaultBasePort', () => {
  it('matches each engine plugin default', () => {
    expect(mcpDefaultBasePort('unreal')).toBe(8001);
    expect(mcpDefaultBasePort('unity')).toBe(8080);
    expect(MCP_DEFAULT_BASE_PORT.unreal).toBe(8001);
    expect(MCP_DEFAULT_BASE_PORT.unity).toBe(8080);
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

describe('unityMcpUrlArg', () => {
  it('produces the -url loopback arg the Unity-MCP plugin expects', () => {
    expect(unityMcpUrlArg(8080)).toBe('-url=http://localhost:8080');
  });

  it('embeds the per-slot port', () => {
    expect(unityMcpUrlArg(8082)).toBe('-url=http://localhost:8082');
  });
});
