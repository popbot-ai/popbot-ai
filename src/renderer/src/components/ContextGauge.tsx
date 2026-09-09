import { useEffect, useState, type MouseEvent } from 'react';
import type { AgentBackendId } from '@shared/persistence';
import { contextFillLevel, contextFillPct } from '@shared/contextUsage';
import { fmtTokens } from '../fixtures/data';
import { useTranslation } from '../lib/i18n';

const RADIUS = 6.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const MENU_WIDTH = 240;

interface ContextGaugeProps {
  /** Tokens the conversation occupies, and the window it's measured against. */
  used: number;
  budget: number;
  agent: AgentBackendId;
  /** A compaction is in flight — the ring spins instead of reporting a fill. */
  compacting: boolean;
  /** The agent is mid-turn: a compaction now would queue behind it. */
  running: boolean;
  onCompact: () => void;
}

/**
 * Ring gauge in the composer showing how full the agent's context window
 * is. Click or right-click opens the compaction menu.
 *
 * Only Claude reports its context fill (the CLI measures it against the
 * window it will autocompact at). Codex's SDK reports per-turn totals
 * only, so for Codex the ring is drawn empty and dashed, and the menu
 * explains why manual compaction is unavailable there.
 */
export function ContextGauge({
  used,
  budget,
  agent,
  compacting,
  running,
  onCompact,
}: ContextGaugeProps): JSX.Element {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Close on outside click / scroll / Escape. Clicks inside the menu stop
  // propagation before they reach the document listener.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const reported = agent !== 'codex';
  const pct = reported ? contextFillPct(used, budget) : 0;
  const level = contextFillLevel(pct);
  // Once there is any usage at all, draw at least a sliver so a 1% chat
  // reads as "a little" rather than "nothing".
  const arcPct = pct > 0 ? Math.max(pct, 3) : 0;
  const dash = (arcPct / 100) * CIRCUMFERENCE;
  const summary = reported
    ? t('chat.context.title', { used: fmtTokens(used), budget: fmtTokens(budget), pct })
    : t('chat.context.unreported', { used: fmtTokens(used) });
  const title = compacting ? t('chat.context.compactingTitle') : summary;
  const canCompact = reported && !compacting && !running;
  const hint = !reported
    ? t('chat.context.menu.codexHint')
    : running && !compacting
      ? t('chat.context.menu.runningHint')
      : null;

  const openMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const className = [
    'ctx-gauge',
    level,
    compacting ? 'compacting' : '',
    reported ? '' : 'unreported',
  ].filter(Boolean).join(' ');

  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        aria-label={t('chat.context.gaugeLabel')}
        onClick={openMenu}
        onContextMenu={openMenu}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle className="ctx-gauge-track" cx="8" cy="8" r={RADIUS} />
          {/* Only drawn when there is something to draw: a zero-length
              dash with a round line cap still renders as a dot. */}
          {(compacting || arcPct > 0) && (
            <circle
              className="ctx-gauge-fill"
              cx="8"
              cy="8"
              r={RADIUS}
              strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
            />
          )}
        </svg>
        {/* The count as well as the percentage: on a 1M-token window a
            working chat sits at a few percent for a long time, and "36k"
            says more than "4%" does on its own. */}
        {!compacting && (
          <span className="ctx-gauge-pct">
            {reported ? `${fmtTokens(used)} · ${pct}%` : fmtTokens(used)}
          </span>
        )}
      </button>
      {menu && (
        <div
          className="ctx-gauge-menu"
          role="menu"
          // Anchored ABOVE the cursor: the composer sits at the bottom of
          // the column, so a menu opening downward would leave the window.
          style={{
            left: Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH)),
            bottom: window.innerHeight - menu.y + 8,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="ctx-gauge-menu-head">{summary}</div>
          <button
            type="button"
            className="ctx-gauge-menu-item"
            role="menuitem"
            disabled={!canCompact}
            title={hint ?? undefined}
            onClick={() => {
              setMenu(null);
              onCompact();
            }}
          >
            <i className={`fa-solid ${compacting ? 'fa-spinner fa-spin' : 'fa-compress'}`} aria-hidden="true" />
            {compacting ? t('chat.context.menu.compacting') : t('chat.context.menu.compact')}
          </button>
          {hint && <div className="ctx-gauge-menu-hint">{hint}</div>}
        </div>
      )}
    </>
  );
}
