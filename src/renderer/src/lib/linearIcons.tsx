/**
 * Linear-style workflow state + priority glyphs as inline SVG. Extracted
 * from PanelA so the ChatColumn status chip can render the same shapes
 * the ticket list does — single source of truth for Linear visuals.
 */

/** Paused / blocked states are technically "started" in Linear's
 *  workflow taxonomy but should read very differently from In Progress
 *  in our UI — same pie-chart shape would make them look like another
 *  In Progress slice. Detect by name and render a pause-bars glyph
 *  with an amber tint instead. */
export function isPausedState(state: { name: string; type: string }): boolean {
  return state.type === 'started' && /paused|on\s*hold|blocked/i.test(state.name);
}

/** Color used for paused/blocked states regardless of the workflow's
 *  own color, so In Progress and Paused stay visually distinct even
 *  when Linear's palette assigns them similar hues. Darker brown to
 *  match Linear's own palette for stalled work. */
export const PAUSED_COLOR = '#a16a3c';

/** Heuristic fill % for "started" states based on the state name.
 *  Linear's API exposes `position` but it's relative to the whole
 *  workflow, and we'd need the team's workflow shape to normalize.
 *  Names cover the standard PoP team progression cleanly. */
export function startedFillPct(name: string): number {
  const n = name.toLowerCase();
  if (/ready\s*(to|for)\s*(deploy|merge|release)/.test(n)) return 0.85;
  if (/(test\s*in\s*progress|qa\s*investigation|testing)/.test(n)) return 0.7;
  if (/(ready\s*(to|for)\s*test|qa|needs.*test)/.test(n)) return 0.55;
  if (/(in\s*review|code\s*review|reviewing)/.test(n)) return 0.45;
  if (/(blocked|on\s*hold|paused)/.test(n)) return 0.3;
  if (/(in\s*progress|started|doing|wip)/.test(n)) return 0.25;
  return 0.4;
}

function PieFillSvg({ color, fillPct, size }: { color: string; fillPct: number; size: number }): JSX.Element {
  const pad = 1.5;
  const r = size / 2 - pad;
  const cx = size / 2, cy = size / 2;
  const f = Math.max(0, Math.min(0.999, fillPct));
  const angle = f * 2 * Math.PI - Math.PI / 2;
  const x = cx + r * Math.cos(angle);
  const y = cy + r * Math.sin(angle);
  const largeArc = f > 0.5 ? 1 : 0;
  const wedge = f === 0
    ? null
    : <path d={`M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`} fill={color} />;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
      {wedge}
    </svg>
  );
}

export function LinearStateIcon({ state, size = 14 }: {
  state: { name: string; type: string; color?: string };
  size?: number;
}): JSX.Element {
  const color = state.color || '#94a3b8';
  // Paused/blocked: round, but not a pie-chart, so they don't blend
  // into the In Progress / In Review etc. siblings. Color is forced
  // to PAUSED_COLOR so they stay distinct even when Linear's
  // workflow color assigns them similar hues to In Progress.
  //   - Blocked → ghostbusters circle-and-slash (work cannot proceed).
  //   - Paused  → pause-bars inside a circle (work is on hold).
  if (isPausedState(state)) {
    if (/blocked/i.test(state.name)) {
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
          <circle cx={8} cy={8} r={6.5} fill="none" stroke={PAUSED_COLOR} strokeWidth={1.6} />
          <line x1={3.6} y1={12.4} x2={12.4} y2={3.6} stroke={PAUSED_COLOR} strokeWidth={1.6} strokeLinecap="round" />
        </svg>
      );
    }
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx={8} cy={8} r={6.5} fill="none" stroke={PAUSED_COLOR} strokeWidth={1.6} />
        <rect x="5.6" y="5"   width="1.4" height="6" rx="0.5" fill={PAUSED_COLOR} />
        <rect x="9"   y="5"   width="1.4" height="6" rx="0.5" fill={PAUSED_COLOR} />
      </svg>
    );
  }
  if (state.type === 'completed') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx={8} cy={8} r={7} fill={color} />
        <path d="M5 8.2 L7.2 10.4 L11 6.5" fill="none" stroke="white"
              strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state.type === 'canceled') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx={8} cy={8} r={7} fill="#94a3b8" />
        <path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" stroke="white"
              strokeWidth={1.4} strokeLinecap="round" />
      </svg>
    );
  }
  if (state.type === 'backlog') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx={8} cy={8} r={7} fill="none" stroke="#94a3b8"
                strokeWidth={1.4} strokeDasharray="2 2" />
      </svg>
    );
  }
  if (state.type === 'triage') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx={8} cy={8} r={7} fill={color} />
        <path d="M8 4.5 L8 8.5 M8 10.4 L8 11.4" stroke="white"
              strokeWidth={1.6} strokeLinecap="round" />
      </svg>
    );
  }
  if (state.type === 'unstarted') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx={8} cy={8} r={7} fill="none" stroke={color} strokeWidth={1.5} />
      </svg>
    );
  }
  return <PieFillSvg color={color} fillPct={startedFillPct(state.name)} size={size} />;
}
