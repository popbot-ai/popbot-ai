import { describe, expect, it } from 'vitest';
import {
  isMcpTool,
  mcpServerOfTool,
  mcpServerWildcard,
  permissionRuleMatches,
  resolvePermissionRules,
  type PermissionRule,
} from './agent';

describe('permissionRuleMatches', () => {
  it('matches an exact tool name', () => {
    expect(permissionRuleMatches('Bash', 'Bash')).toBe(true);
    expect(permissionRuleMatches('Bash', 'Read')).toBe(false);
  });

  it('matches a trailing-* prefix', () => {
    expect(permissionRuleMatches('mcp__unrealEditor__*', 'mcp__unrealEditor__call_tool')).toBe(true);
    expect(permissionRuleMatches('mcp__unrealEditor__*', 'mcp__unityEditor__call_tool')).toBe(false);
    expect(permissionRuleMatches('mcp__*', 'mcp__anything__x')).toBe(true);
  });
});

describe('resolvePermissionRules', () => {
  const rules: PermissionRule[] = [
    { tool: 'mcp__unrealEditor__*', action: 'allow' },
    { tool: 'mcp__unrealEditor__DeleteEverything', action: 'deny' },
    { tool: 'Bash', action: 'deny' },
  ];

  it('applies a wildcard allow to a matching MCP tool', () => {
    expect(resolvePermissionRules(rules, 'mcp__unrealEditor__call_tool')).toBe('allow');
  });

  it('lets a specific DENY override a broader wildcard ALLOW', () => {
    expect(resolvePermissionRules(rules, 'mcp__unrealEditor__DeleteEverything')).toBe('deny');
  });

  it('returns null when nothing matches', () => {
    expect(resolvePermissionRules(rules, 'mcp__unityEditor__x')).toBeNull();
    expect(resolvePermissionRules([], 'Bash')).toBeNull();
  });

  it('deny wins over allow regardless of order', () => {
    expect(
      resolvePermissionRules(
        [
          { tool: 'X', action: 'allow' },
          { tool: 'X', action: 'deny' },
        ],
        'X',
      ),
    ).toBe('deny');
  });
});

describe('MCP tool-name helpers', () => {
  it('isMcpTool detects the mcp__ namespace', () => {
    expect(isMcpTool('mcp__unrealEditor__call_tool')).toBe(true);
    expect(isMcpTool('Bash')).toBe(false);
  });

  it('mcpServerOfTool extracts the server segment', () => {
    expect(mcpServerOfTool('mcp__unrealEditor__call_tool')).toBe('unrealEditor');
    expect(mcpServerOfTool('mcp__unityEditor__list_toolsets')).toBe('unityEditor');
    expect(mcpServerOfTool('Bash')).toBeNull();
  });

  it('mcpServerWildcard builds the whole-server pattern', () => {
    expect(mcpServerWildcard('unrealEditor')).toBe('mcp__unrealEditor__*');
    // round-trips with the matcher
    expect(permissionRuleMatches(mcpServerWildcard('unrealEditor'), 'mcp__unrealEditor__anything')).toBe(true);
  });
});
