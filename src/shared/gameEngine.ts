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
  /** Unreal only: when on, the editor is launched with a command-line override
   *  that sets the MCP server's listen port, so each slot's Editor exposes MCP
   *  on its own port and agents don't collide. Default off. */
  useMcp?: boolean;
  /** Unreal only: base MCP port for slot 1. Each slot uses `mcpBasePort +
   *  (slotId - 1)` (slot 1 → base, slot 2 → base+1, …).
   *  Default {@link UNREAL_MCP_DEFAULT_BASE_PORT}. */
  mcpBasePort?: number;
}

/** Default base MCP port for Unreal — slot 1's port. */
export const UNREAL_MCP_DEFAULT_BASE_PORT = 8001;

/** The per-slot Unreal MCP port: the base for slot 1, +1 for each slot after.
 *  `slotId` is the 1-based slot index; a missing/invalid slot falls back to 1. */
export function unrealMcpPort(basePort: number, slotId: number | null | undefined): number {
  const slot = slotId && slotId > 0 ? slotId : 1;
  return basePort + (slot - 1);
}

/** Unreal editor command-line argument that overrides the MCP server's listen
 *  port. Injected at launch when `useMcp` is on. The `-ini:` form sets a config
 *  value for this process only (it does not write the project's .ini files):
 *  Section [/Script/…ModelContextProtocolSettings], key ServerPortNumber. */
export function unrealMcpIniArg(port: number): string {
  return `-ini:Engine:[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]:ServerPortNumber=${port}`;
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
