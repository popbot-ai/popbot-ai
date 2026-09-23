import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AuthProvider } from '@shared/ipc';
import { useTranslation } from '../lib/i18n';

interface SignInDialogProps {
  provider: AuthProvider;
  onClose: () => void;
}

/**
 * Runs the agent CLI's own sign-in and shows the user what it needs.
 *
 * Claude Code's login opens the browser, prints a fallback URL, and
 * waits for a code to be pasted; Codex's login opens the browser and
 * completes on its own. The dialog shows the URL as a link, offers a
 * code box, mirrors the CLI's output so nothing is hidden, and reports
 * the outcome. The parent re-probes readiness when it closes.
 */
export function SignInDialog({ provider, onClose }: SignInDialogProps): JSX.Element {
  const { t } = useTranslation();
  const vendor = provider === 'claude' ? 'Claude' : 'Codex';
  const [lines, setLines] = useState<string[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  const [wantsCode, setWantsCode] = useState(false);
  const [exit, setExit] = useState<{ code: number; message?: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [attempt, setAttempt] = useState(0);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLines([]);
    setUrl(null);
    setWantsCode(false);
    setExit(null);
    setStartError(null);
    const off = window.popbot.auth.onLoginEvent((event) => {
      if (event.provider !== provider) return;
      if (event.type === 'output') setLines((prev) => [...prev, event.line].slice(-8));
      else if (event.type === 'url') setUrl(event.url);
      else if (event.type === 'prompt-code') setWantsCode(true);
      else if (event.type === 'exit') setExit({ code: event.code, message: event.message });
    });
    void window.popbot.auth.startLogin(provider).then((res) => {
      if (!res.ok) setStartError(res.error);
    });
    return off;
  }, [provider, attempt]);

  // A finished sign-in closes itself after a beat — long enough to read.
  useEffect(() => {
    if (exit?.code !== 0) return;
    const id = window.setTimeout(onClose, 1200);
    return () => window.clearTimeout(id);
  }, [exit, onClose]);

  useEffect(() => {
    if (wantsCode) codeRef.current?.focus();
  }, [wantsCode]);

  const cancel = (): void => {
    if (!exit) void window.popbot.auth.cancelLogin(provider);
    onClose();
  };
  const submitCode = (): void => {
    const text = code.trim();
    if (!text) return;
    void window.popbot.auth.sendLoginInput(provider, text);
    setCode('');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit]);

  const running = !exit && !startError;
  return createPortal(
    <div className="confirm-scrim" onMouseDown={cancel}>
      <div
        className="confirm-dialog sign-in-dialog"
        role="dialog"
        aria-label={t('auth.signIn.title', { vendor })}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          <i className="fa-solid fa-right-to-bracket" aria-hidden /> {t('auth.signIn.title', { vendor })}
        </div>
        <div className="confirm-body">
          {startError ? (
            <p className="sign-in-status err">{startError}</p>
          ) : exit ? (
            <p className={`sign-in-status ${exit.code === 0 ? 'ok' : 'err'}`}>
              <i className={`fa-solid ${exit.code === 0 ? 'fa-circle-check' : 'fa-circle-exclamation'}`} aria-hidden />{' '}
              {exit.code === 0
                ? t('auth.signIn.done')
                : `${t('auth.signIn.failed', { code: exit.code })}${exit.message ? ` ${exit.message}` : ''}`}
            </p>
          ) : (
            <p className="sign-in-status">
              <i className="fa-solid fa-spinner fa-spin" aria-hidden /> {t('auth.signIn.opening')}
            </p>
          )}
          {running && url && (
            <p className="sign-in-fallback">
              {t('auth.signIn.fallback')}{' '}
              <a href={url} target="_blank" rel="noreferrer noopener">{t('auth.signIn.openLink')}</a>
            </p>
          )}
          {running && (wantsCode || provider === 'claude') && (
            <div className="sign-in-code">
              <label htmlFor="sign-in-code">{t('auth.signIn.pasteCode')}</label>
              <div className="sign-in-code-row">
                <input
                  id="sign-in-code"
                  ref={codeRef}
                  className="input mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitCode();
                    }
                    e.stopPropagation();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn primary sm" disabled={!code.trim()} onClick={submitCode}>
                  {t('auth.signIn.continue')}
                </button>
              </div>
            </div>
          )}
          {lines.length > 0 && (
            <pre className="sign-in-log" aria-label="CLI output">{lines.join('\n')}</pre>
          )}
        </div>
        <div className="confirm-foot">
          {exit && exit.code !== 0 && (
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>{t('auth.signIn.retry')}</button>
          )}
          <button className="btn ghost" onClick={cancel}>
            {exit ? t('common.close') : t('common.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
