import { describe, expect, it } from 'vitest';
import {
  MCP_DEFAULT_BASE_PORT,
  mcpDefaultBasePort,
  mcpEndpointUrl,
  mcpPortForSlot,
  mcpServerName,
  unityMcpUrlArg,
  unrealMcpArgs,
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
    // Unreal → Epic's ModelContextProtocol default (8000); Unity → Unity-MCP's.
    expect(mcpDefaultBasePort('unreal')).toBe(8000);
    expect(mcpDefaultBasePort('unity')).toBe(8080);
    expect(MCP_DEFAULT_BASE_PORT.unreal).toBe(8000);
    expect(MCP_DEFAULT_BASE_PORT.unity).toBe(8080);
  });
});

describe('unrealMcpArgs', () => {
  it('starts the server AND sets the port (the plugin needs both)', () => {
    // Without -ModelContextProtocolStartServer the plugin's Auto Start Server
    // pref defaults off, so the server never starts and the port is moot.
    expect(unrealMcpArgs(8001)).toEqual([
      '-ModelContextProtocolStartServer',
      '-ModelContextProtocolPort=8001',
    ]);
  });

  it('embeds the per-slot port', () => {
    expect(unrealMcpArgs(8003)).toContain('-ModelContextProtocolPort=8003');
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

describe('agent-facing MCP endpoint', () => {
  it('mcpEndpointUrl points at the per-slot /mcp endpoint on loopback', () => {
    expect(mcpEndpointUrl(8080)).toBe('http://127.0.0.1:8080/mcp');
    expect(mcpEndpointUrl(8082)).toBe('http://127.0.0.1:8082/mcp');
  });

  it('mcpServerName is stable per engine', () => {
    expect(mcpServerName('unity')).toBe('unityEditor');
    expect(mcpServerName('unreal')).toBe('unrealEditor');
  });
});
