/**
 * Game-engine launch abstraction.
 *
 * Unlike the ticket source (a single active provider), engines are
 * INDEPENDENTLY enable-able — a shop can have Unity, Unreal, and a Custom
 * engine all wired up at once. Each enabled engine gets its own "Run editor"
 * button on the chat bar and its own config panel in Preferences → Integrations.
 *
 *   - unity  / unreal → launch a known editor binary we can auto-detect
 *     (Unity Hub installs / Epic Games installs) at the chat's project path.
 *   - custom          → a freeform shell command (separate posix + Windows
 *     variants), run in the project directory. No detection.
 */

export type GameEngineId = 'unity' | 'unreal' | 'custom';

/** Per-engine configuration, persisted under `apps.engines[id]`. */
export interface GameEngineConfig {
  /** Show this engine's Run button on the chat bar + treat it as active.
   *  Unity defaults on (back-compat with the pre-multi-engine integration);
   *  the others default off until configured. See {@link engineEnabled}. */
  enabled?: boolean;
  /** Absolute path to the editor binary (Unity.exe / UnrealEditor(.exe)).
   *  unity/unreal only. */
  binary?: string;
  /** Project path relative to the worktree root (blank = worktree root).
   *  Unity: the project folder. Unreal: the folder holding the `.uproject`.
   *  Custom: the cwd the command runs in. */
  projectSubpath?: string;
  /** Custom engine: the shell command to run (cwd = the project path). Two
   *  variants so one machine's config works cross-platform. */
  runPosix?: string;
  runWindows?: string;
  /** Unity / Unreal: when on, the editor is launched with a command-line
   *  override that points its MCP integration at a per-slot port, so each
   *  slot's Editor exposes MCP on its own port and agents don't collide.
   *  Default off. */
  useMcp?: boolean;
  /** Unity / Unreal: base MCP port for slot 1. Each slot uses `mcpBasePort +
   *  (slotId - 1)` (slot 1 → base, slot 2 → base+1, …). Default is the engine's
   *  {@link mcpDefaultBasePort}. */
  mcpBasePort?: number;
}

/** Default base MCP port for the engines that support MCP (slot 1's port).
 *   - unreal: 8001, matching the ModelContextProtocol plugin's default.
 *   - unity:  8080, matching IvanMurzak/Unity-MCP's default plugin port.
 *  Custom has no MCP integration, so it isn't listed. */
export const MCP_DEFAULT_BASE_PORT: Record<'unity' | 'unreal', number> = {
  unreal: 8001,
  unity: 8080,
};

/** The default base MCP port for an MCP-capable engine. */
export function mcpDefaultBasePort(id: 'unity' | 'unreal'): number {
  return MCP_DEFAULT_BASE_PORT[id];
}

/** Highest valid TCP port. */
const MAX_PORT = 65535;

/** The per-slot MCP port: the base for slot 1, +1 for each slot after, clamped
 *  to a valid TCP port. `slotId` is the 1-based slot index; a missing/invalid
 *  slot falls back to 1 (the base port). */
export function mcpPortForSlot(basePort: number, slotId: number | null | undefined): number {
  const slot = slotId && slotId > 0 ? slotId : 1;
  return Math.min(MAX_PORT, basePort + (slot - 1));
}

/** Unreal editor command-line argument that overrides the MCP server's listen
 *  port. Injected at launch when `useMcp` is on. The `-ini:` form sets a config
 *  value for this process only (it does not write the project's .ini files):
 *  Section [/Script/…ModelContextProtocolSettings], key ServerPortNumber. */
export function unrealMcpIniArg(port: number): string {
  return `-ini:Engine:[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]:ServerPortNumber=${port}`;
}

/** Unity editor command-line argument that points the MCP plugin (IvanMurzak/
 *  Unity-MCP) at a per-slot server URL. `-url` is the current alias for
 *  UNITY_MCP_CLOUD_URL; a loopback URL puts the plugin in Custom connection
 *  mode. Only the port varies per slot. */
export function unityMcpUrlArg(port: number): string {
  return `-url=http://localhost:${port}`;
}

/** All engines' configs, keyed by id. Stored on the `apps` settings blob. */
export type GameEnginesSettings = Partial<Record<GameEngineId, GameEngineConfig>>;

/** Static descriptor — drives the config panels + the chat-bar buttons. */
export interface GameEngineMeta {
  id: GameEngineId;
  label: string;
  /** true when we can auto-detect installs (a known editor binary). Custom is
   *  a freeform command, so it has no detection. */
  detectable: boolean;
  /** Accent color for the chat-bar button. */
  color: string;
}

export const GAME_ENGINES: GameEngineMeta[] = [
  { id: 'unity', label: 'Unity', detectable: true, color: '#d6a13b' },
  { id: 'unreal', label: 'Unreal Engine', detectable: true, color: '#7aa2ff' },
  { id: 'custom', label: 'Custom Engine', detectable: false, color: '#e0b64d' },
];

export function engineMeta(id: GameEngineId): GameEngineMeta {
  return GAME_ENGINES.find((e) => e.id === id) ?? GAME_ENGINES[0];
}

/** Whether an engine is allowed to surface on a chat (gates the detected
 *  engine's Run button). Unity + Unreal default ON — the chat bar only shows
 *  one when the chat's project is actually detected as that engine, so there
 *  are no spurious buttons. Custom has no project marker (it's a freeform
 *  command), so it defaults OFF and shows only when you opt in. */
export function engineEnabled(cfg: GameEngineConfig | undefined, id: GameEngineId): boolean {
  return cfg?.enabled ?? id !== 'custom';
}
