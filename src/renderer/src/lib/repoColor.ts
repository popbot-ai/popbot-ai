/**
 * Per-chat accent helpers for the multi-repo color theming system.
 *
 * Centralized so every consumer (chat column, monitor card, chat-list
 * row, terminal panel button, etc.) sets one CSS variable:
 *
 *   --col-accent — the repo's color, used by background / border /
 *                  glow rules across the app.
 *
 * White text is hardcoded on accent-bg surfaces (Send button, slot
 * pip, etc.). That works because every color in {@link POPBOT_PALETTE}
 * was hand-picked to be dark enough for comfortable white text — no
 * runtime perceptual contrast check needed. Restricting the user to
 * the curated palette (rather than the freeform color picker) is what
 * lets us keep the foreground simple.
 */
import type { CSSProperties } from 'react';

/**
 * Curated repo accent palette. All twelve colors sit in the
 * luminance range where white text reads well, share comparable
 * saturation so no repo screams louder than the others, and
 * harmonize with the default apple-blue accent. Index 0 is the
 * default for new repos.
 *
 * Adding/removing colors here is a UX call — keep the count at 12
 * so the swatch grid stays a nice 4×3 / 3×4. Order is "warm to
 * cool around the wheel" so the picker reads as a continuous spread.
 */
export const POPBOT_PALETTE: ReadonlyArray<{ value: string; name: string }> = [
  { value: '#6b7cff', name: 'Blue' },       // app default
  { value: '#4f8bff', name: 'Sky' },
  { value: '#38a3c0', name: 'Teal' },
  { value: '#3a9d72', name: 'Green' },
  { value: '#689d52', name: 'Lime' },
  { value: '#a08840', name: 'Amber' },
  { value: '#d97e3e', name: 'Orange' },
  { value: '#d65c5c', name: 'Red' },
  { value: '#c45e8c', name: 'Pink' },
  { value: '#b079d9', name: 'Lavender' },
  { value: '#8a6fd8', name: 'Violet' },
  { value: '#7d8fc7', name: 'Slate' },
];

/** The default accent for newly-created repos. */
export const DEFAULT_REPO_COLOR: string = POPBOT_PALETTE[0].value;

/**
 * Build the inline `style` object that sets `--col-accent` for a
 * chat or panel. Returns `undefined` when there's no color so callers
 * can spread it into JSX without a wrapper:
 *
 *   <div style={colAccentStyle(chat.repoColor)} />
 *
 * The CSS rules across the app fall back via `var(--col-accent, var(--acc))`
 * so an undefined return leaves the element on the default apple-blue
 * accent.
 */
export function colAccentStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return { '--col-accent': color } as CSSProperties;
}
