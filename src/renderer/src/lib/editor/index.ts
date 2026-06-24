/**
 * Pluggable handler for "open this file in the user's external code
 * editor." Each implementation maps a path (+ optional line) to a URL
 * that the OS knows how to launch via Electron's `shell.openExternal`.
 *
 * For now we ship VSCodeEditor as the only concrete implementation.
 * `getExternalEditor()` is the single call site; once we surface the
 * choice in Preferences, the factory will read it from settings.
 */

export interface ExternalEditor {
  /** Stable id used by settings (`vscode` | `cursor` | `jetbrains` | …). */
  readonly id: string;
  /** Human-readable name for the prefs picker. */
  readonly displayName: string;
  /**
   * Build a URL that launches the external editor at `absPath`
   * (optionally jumping to `line`). Returned as a string so callers
   * can stick it in `<a href>` and let Electron's openExternal handler
   * route it to the OS — no extra IPC hop needed.
   */
  fileUrl(absPath: string, line?: number): string;
}

export class VSCodeEditor implements ExternalEditor {
  readonly id = 'vscode';
  readonly displayName = 'Visual Studio Code';
  fileUrl(absPath: string, line?: number): string {
    // Normalize to a file-URL path: Windows `C:\a\b` → `/C:/a/b`
    // (backslashes → `/`, leading slash before the drive letter);
    // POSIX paths pass through. VS Code expects an absolute path.
    let abs = absPath.replace(/\\/g, '/');
    if (!abs.startsWith('/')) abs = `/${abs}`;
    return `vscode://file${abs}${line ? `:${line}` : ''}`;
  }
}

/**
 * Returns the configured external editor. Today: always VS Code. Wire
 * to `settings.editor.id` once the picker lands in Preferences.
 */
export function getExternalEditor(): ExternalEditor {
  return new VSCodeEditor();
}
