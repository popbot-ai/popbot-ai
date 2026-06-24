/**
 * Platform-aware hotkey label formatting for UI chips/tooltips.
 *
 * macOS uses the ⌘ glyph (and ⇧ / ⌥ / ↵) with the modifiers run
 * together (`⌘⇧T`); Windows/Linux spell it out with `+` separators
 * (`Ctrl+Shift+T`). The underlying handlers accept both Cmd and Ctrl —
 * this is purely how we *display* the shortcut.
 */
function isMac(): boolean {
  return typeof window !== 'undefined' && window.popbot?.platform === 'darwin';
}

/** macOS glyphs for keys that aren't a literal character. */
const MAC_KEY_GLYPH: Record<string, string> = {
  Enter: '↵',
  Return: '↵',
};

/**
 * Format the primary-modifier shortcut for display.
 *   hotkey('K')                 → '⌘K'        / 'Ctrl+K'
 *   hotkey('T', { shift: true}) → '⌘⇧T'       / 'Ctrl+Shift+T'
 *   hotkey('Enter')             → '⌘↵'        / 'Ctrl+Enter'
 */
export function hotkey(key: string, mods?: { shift?: boolean; alt?: boolean }): string {
  if (isMac()) {
    const alt = mods?.alt ? '⌥' : '';
    const shift = mods?.shift ? '⇧' : '';
    return `⌘${alt}${shift}${MAC_KEY_GLYPH[key] ?? key}`;
  }
  const parts = ['Ctrl'];
  if (mods?.alt) parts.push('Alt');
  if (mods?.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}
