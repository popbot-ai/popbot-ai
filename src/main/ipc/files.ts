import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { IpcChannel, type PickedAttachment } from '@shared/ipc';
import { pruneExpiredChatAttachments } from '../attachments/store';
import { getChat } from '../persistence/chats';
import { getRepo } from '../persistence/repos';
import { getSetting } from '../persistence/settings';
import { worktreePathForChat } from '../git/chatPaths';

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap so we don't load gigantic generated files

/** Best-effort cwd for a chat, mirroring AgentHost.spawn's precedence:
 *  slot/ephemeral worktree → repo root → configured git repo. Used to
 *  resolve relative file references the agent emits in chat. */
function resolveChatCwd(chatId: string | null): string | null {
  if (!chatId) return null;
  const chat = getChat(chatId);
  if (!chat) return null;
  const wt = worktreePathForChat(chat);
  if (wt) return wt;
  const repo = chat.repoId ? getRepo(chat.repoId) : null;
  return repo?.repoPath ?? getSetting<{ repoPath?: string }>('git')?.repoPath ?? null;
}

/** Build the URL-scheme deep link for the configured editor (VS Code or
 *  Cursor). Both accept `<scheme>://file/<abs>:<line>`. */
function editorUrlFor(absPath: string, line?: number): string {
  const editor = (getSetting<{ editorApp?: string }>('apps')?.editorApp || 'vscode').toLowerCase();
  const scheme = editor === 'cursor' ? 'cursor' : 'vscode';
  const abs = absPath.startsWith('/') ? absPath : `/${absPath}`;
  const lineSuffix = line ? `:${line}` : '';
  return `${scheme}://file${abs}${lineSuffix}`;
}

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif',
  '.heic', '.heif', '.svg', '.avif',
]);

function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

export function registerFilesHandlers(): void {
  void pruneExpiredChatAttachments().catch((err) => {
    console.warn(`[attachments] prune failed: ${(err as Error).message}`);
  });

  /** Used by the chat UI to deep-link Edit-tool file references at the
   *  exact line of the change in the user's external editor. */
  ipcMain.handle(
    IpcChannel.FilesLineOfText,
    (_e, path: string, needle: string): number | null => {
      if (!path || !needle) return null;
      if (!existsSync(path)) return null;
      try {
        const buf = readFileSync(path, { encoding: 'utf-8' });
        if (buf.length > MAX_BYTES) return null;
        const idx = buf.indexOf(needle);
        if (idx < 0) return null;
        // Count newlines before the match → 0-based line, +1 for 1-based.
        let line = 1;
        for (let i = 0; i < idx; i++) if (buf.charCodeAt(i) === 10) line++;
        return line;
      } catch {
        return null;
      }
    },
  );

  /** Native file picker for the chat input attach buttons. The picker
   *  returns source paths for pending chips; AgentHost copies them into
   *  PopBot's retained attachment store at send time so chat history
   *  can keep opening them after the original moves. */
  ipcMain.handle(
    IpcChannel.FilesPickAttachment,
    async (e, kind: 'image' | 'any'): Promise<PickedAttachment[] | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const filters = kind === 'image'
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'svg', 'avif'] }]
        : [{ name: 'All Files', extensions: ['*'] }];
      const result = await dialog.showOpenDialog(win!, {
        title: kind === 'image' ? 'Attach image' : 'Attach file',
        properties: ['openFile', 'multiSelections'],
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths.map((path) => {
        let sizeBytes = 0;
        try { sizeBytes = statSync(path).size; } catch { /* best-effort */ }
        return {
          id: 'att_' + randomUUID().replace(/-/g, '').slice(0, 12),
          path,
          name: basename(path),
          sizeBytes,
          isImage: isImageExt(extname(path)),
        };
      });
    },
  );

  ipcMain.handle(
    IpcChannel.FilesOpenAttachment,
    async (_e, path: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!path || !existsSync(path)) return { ok: false, error: 'Attachment file is missing or expired.' };
      const error = await shell.openPath(path);
      return error ? { ok: false, error } : { ok: true };
    },
  );

  /** Open a file the agent referenced in chat in the user's configured
   *  editor. We call `shell.openExternal` directly (rather than routing
   *  through the renderer's `window.open`, which the browser-profile
   *  router would hijack and hand a `vscode://` URL to Chrome). Relative
   *  paths resolve against the chat's cwd; a trailing `:line[:col]` (or
   *  the explicit `line` arg) jumps the cursor. */
  ipcMain.handle(
    IpcChannel.FilesOpenInEditor,
    async (
      _e,
      chatId: string | null,
      rawPath: string,
      line?: number,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!rawPath || typeof rawPath !== 'string') return { ok: false, error: 'No file path.' };
      let p = rawPath.trim();
      let lineNum = typeof line === 'number' && Number.isFinite(line) ? line : undefined;
      // Strip a GitHub-style line anchor (foo.ts#L42 / #L42-L51) — the
      // form CLAUDE.md emits for markdown file links.
      const hash = /^(.*)#L(\d+)(?:-L?\d+)?$/.exec(p);
      if (hash) { p = hash[1]; lineNum ??= Number.parseInt(hash[2], 10); }
      // Pull a trailing :line[:col] off the path when no explicit line.
      if (lineNum == null) {
        const m = /^(.+?):(\d+)(?::\d+)?$/.exec(p);
        if (m) { p = m[1]; lineNum = Number.parseInt(m[2], 10); }
      }
      // Resolve relative refs against the chat's workspace.
      if (!isAbsolute(p)) {
        const cwd = resolveChatCwd(chatId);
        if (!cwd) return { ok: false, error: `No workspace to resolve relative path: ${p}` };
        p = join(cwd, p);
      }
      if (!existsSync(p)) return { ok: false, error: `File not found: ${p}` };
      try {
        await shell.openExternal(editorUrlFor(p, lineNum));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /** Directory picker — used by the New Repo wizard so the user can
   *  browse for the source clone instead of typing an absolute path.
   *  `defaultPath`: seeds where the dialog opens. When the supplied
   *  path doesn't exist (e.g. user typed a partial), fall back to its
   *  parent directory and finally $HOME so we never hand Electron an
   *  invalid `defaultPath` (which throws on macOS). */
  ipcMain.handle(
    IpcChannel.FilesPickDirectory,
    async (e, opts?: { title?: string; defaultPath?: string }): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      let defaultPath = homedir();
      if (opts?.defaultPath) {
        if (existsSync(opts.defaultPath)) defaultPath = opts.defaultPath;
        else {
          const parent = dirname(opts.defaultPath);
          if (existsSync(parent)) defaultPath = parent;
        }
      }
      const result = await dialog.showOpenDialog(win!, {
        title: opts?.title ?? 'Choose a folder',
        properties: ['openDirectory'],
        defaultPath,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
  );
}
