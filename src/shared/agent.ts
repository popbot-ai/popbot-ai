/**
 * Agent event stream — what the main process pushes to the renderer for a
 * live chat session. Modeled on the Claude Agent SDK's event shape so the
 * stub backend and the real backend produce indistinguishable streams.
 */

import type { MessageRecord } from './persistence';

export type AgentEventType =
  | 'message-start'
  | 'text-delta'
  | 'tool-use'
  | 'tool-result'
  | 'permission-request'
  | 'message-end'
  | 'session-status'
  | 'usage'
  | 'error';

export interface MessageStartEvent {
  type: 'message-start';
  chatId: string;
  messageId: string;
  role: 'agent';
  ts: number;
}

export interface TextDeltaEvent {
  type: 'text-delta';
  chatId: string;
  messageId: string;
  delta: string;
  ts: number;
}

export interface ToolUseEvent {
  type: 'tool-use';
  chatId: string;
  messageId: string;
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
  ts: number;
}

export interface ToolResultEvent {
  type: 'tool-result';
  chatId: string;
  messageId: string;
  toolUseId: string;
  isError: boolean;
  /** Stringified result (markdown / text / JSON). */
  text: string;
  ts: number;
}

export interface PermissionRequestEvent {
  type: 'permission-request';
  chatId: string;
  permissionId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Agent's stated reason for wanting this. */
  reason?: string;
  ts: number;
}

export interface MessageEndEvent {
  type: 'message-end';
  chatId: string;
  messageId: string;
  ts: number;
}

export interface SessionStatusEvent {
  type: 'session-status';
  chatId: string;
  status: 'running' | 'idle' | 'paused' | 'errored' | 'complete';
  ts: number;
}

export interface UsageEvent {
  type: 'usage';
  chatId: string;
  tokens: { used: number; budget: number };
  ts: number;
}

export interface ErrorEvent {
  type: 'error';
  chatId: string;
  message: string;
  ts: number;
}

/**
 * Emitted when AgentHost has just inserted a complete row into the DB
 * outside the streaming-text flow (e.g. the user's own message). Lets the
 * renderer's useMessages append it without waiting for a refetch.
 */
export interface MessageAddedEvent {
  type: 'message-added';
  chatId: string;
  message: MessageRecord;
  ts: number;
}

/**
 * Emitted when the user's allow/deny on a permission card has been
 * recorded into the row's body. Renderer uses this to flip its in-memory
 * permission message from undecided → decided so the big card collapses.
 */
export interface PermissionDecidedEvent {
  type: 'permission-decided';
  chatId: string;
  permissionId: string;
  decision: PermissionDecision;
  ts: number;
}

export type AgentEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionDecidedEvent
  | MessageEndEvent
  | MessageAddedEvent
  | SessionStatusEvent
  | UsageEvent
  | ErrorEvent;

/**
 * User decision on a permission prompt. The scope determines whether
 * we also persist a rule that auto-resolves matching future prompts:
 *   - `allow` / `deny`           — once, no rule stored
 *   - `allow-chat`               — allow rule stored on the chat record
 *   - `allow-everywhere` / `deny-everywhere` — rule stored in global settings
 *
 * Asymmetric on purpose: we expose three allow scopes (once / chat / global)
 * because "trust this tool here but not elsewhere" is a real workflow,
 * but we only expose two deny scopes (once / global). A per-chat deny
 * is rarely useful — if you don't trust a tool at all, you want it off
 * everywhere; if you do trust it, you decide per-call.
 *
 * Rules are tool-name only in v1; command-pattern matching is deferred.
 */
export type PermissionDecision =
  | 'allow'
  | 'allow-chat'
  | 'allow-everywhere'
  | 'deny'
  | 'deny-everywhere';

/** Stored permission rule. `tool` is an exact tool name OR a trailing-`*`
 *  wildcard prefix (e.g. `mcp__unrealEditor__*` matches every tool from that
 *  MCP server; `mcp__*` matches every MCP tool). */
export interface PermissionRule {
  tool: string;
  action: 'allow' | 'deny';
}

/** Does a permission rule's `tool` pattern match a concrete tool name? Exact
 *  match, or a trailing-`*` prefix match. */
export function permissionRuleMatches(pattern: string, toolName: string): boolean {
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

/** Resolve a tool against a rule list. A DENY that matches always wins over an
 *  ALLOW (fail-safe), and a more specific (longer) pattern wins over a broader
 *  one at the same action. Returns null when no rule matches. */
export function resolvePermissionRules(
  rules: readonly PermissionRule[],
  toolName: string,
): 'allow' | 'deny' | null {
  let best: PermissionRule | null = null;
  for (const r of rules) {
    if (!permissionRuleMatches(r.tool, toolName)) continue;
    // Prefer a deny; among same action prefer the longer (more specific) pattern.
    if (
      !best ||
      (r.action === 'deny' && best.action !== 'deny') ||
      (r.action === best.action && r.tool.length > best.tool.length)
    ) {
      best = r;
    }
  }
  return best ? best.action : null;
}

/** True when a tool is an MCP tool (SDK namespaces them `mcp__<server>__<tool>`). */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__');
}

/** The MCP server portion of an MCP tool name, or null. `mcp__unrealEditor__x`
 *  → `unrealEditor`. Used to offer "allow all tools from this server". */
export function mcpServerOfTool(toolName: string): string | null {
  if (!isMcpTool(toolName)) return null;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep === -1 ? rest : rest.slice(0, sep);
}

/** The wildcard rule pattern that allows every tool from an MCP server. */
export function mcpServerWildcard(server: string): string {
  return `mcp__${server}__*`;
}
