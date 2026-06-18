import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewProps {
  /** Chat whose persistent PTY drives this terminal. */
  chatId: string;
  /** Worktree path the PTY should cd into on first open. */
  cwd: string;
}

/**
 * xterm.js view bound to a per-chat PTY in main. Mounts on focus,
 * unmounts on blur — but the PTY itself persists in main, so the
 * shell session and any in-flight commands survive UI re-mounts.
 *
 * On mount: opens the PTY (or re-attaches if already running),
 * receives the rolling buffer to seed scrollback, then streams live.
 */
export function TerminalView({ chatId, cwd }: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#0c0e12',
        foreground: '#e6e9ef',
        cursor: '#8b98ff',
        selectionBackground: 'rgba(107,124,255,0.32)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Initial fit before opening the PTY so we send accurate dims.
    try { fit.fit(); } catch { /* host may not be sized yet */ }

    let disposed = false;
    let unsubData: (() => void) | null = null;

    void window.popbot.term
      .open(chatId, cwd, term.cols, term.rows)
      .then((res) => {
        if (disposed) return;
        if (res.ok && res.buffer) term.write(stripReplayNoise(res.buffer));
        unsubData = window.popbot.term.onData((evt) => {
          if (evt.chatId !== chatId) return;
          term.write(evt.data);
        });
      });

    const onInput = term.onData((data) => {
      void window.popbot.term.write(chatId, data);
    });

    // Resize forwarding — debounced so we don't flood IPC during a drag.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fit.fit(); } catch { /* */ }
        void window.popbot.term.resize(chatId, term.cols, term.rows);
      }, 80);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      onInput.dispose();
      unsubData?.();
      term.dispose();
      // PTY itself is not disposed here — it persists in main and will
      // be torn down when the chat closes.
    };
  }, [chatId, cwd]);

  return <div ref={hostRef} className="term-host" />;
}

/**
 * Strip terminal-status request escapes that the shell embeds in its
 * prompt (e.g. zsh / starship / oh-my-zsh asking the terminal for its
 * fg/bg/cursor color via OSC 10/11/12, or for cursor position via
 * `CSI 6 n`). On a fresh stream the shell expects + consumes the
 * reply, but on REPLAY xterm sees the query, generates a fresh reply,
 * sends it back to the PTY, and the shell echoes it as gibberish
 * (e.g. `11;rgb:0c0c/0e0e/1212;1R`). Dropping the queries from the
 * replay buffer avoids that — they're harmless to omit since the
 * answer is only meaningful in real time.
 */
function stripReplayNoise(s: string): string {
  // OSC 10/11/12 color queries: ESC ] 1{0,1,2} ; ? (BEL | ESC \)
  // CSI device-status / cursor-position: ESC [ 6 n
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]1[012];\?(\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[6n/g, '');
}
