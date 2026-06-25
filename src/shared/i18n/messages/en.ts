/**
 * English message catalog — the SOURCE OF TRUTH for localization.
 *
 * Every other locale is a `Partial` of this object's keys (see
 * `../types.ts`), and any key missing from a locale falls back to the
 * English string here. That means:
 *   - This file must contain EVERY user-facing string key.
 *   - Adding a new string = add it here first, then translate.
 *
 * Interpolation: use `{name}` placeholders and pass values as the second
 * argument to `t()`, e.g. `t('about.version', { version: '1.2.3' })`.
 *
 * Keys are namespaced by surface (`menu.*`, `about.*`, `prefs.*`, …) so
 * the catalog stays navigable as more of the app gets localized.
 */
export const en = {
  // Generic, reused across dialogs.
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.done': 'Done',

  // Custom Windows/Linux menu bar (MenuBar.tsx) + native app menu.
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.help': 'Help',
  'menu.newChat': 'New Chat',
  'menu.preferences': 'Preferences…',
  'menu.quit': 'Quit PopBot',
  'menu.undo': 'Undo',
  'menu.redo': 'Redo',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'menu.gitPanel': 'Git Panel',
  'menu.resetZoom': 'Reset Zoom',
  'menu.zoomIn': 'Zoom In',
  'menu.zoomOut': 'Zoom Out',
  'menu.documentation': 'Documentation',
  'menu.configGuide': 'Configuration Guide',
  'menu.reportIssue': 'Report an Issue',
  'menu.about': 'About PopBot',

  // About dialog (AboutDialog.tsx).
  'about.version': 'Version {version}',
  'about.versionUnknown': 'Version …',
  'about.checking': 'Checking for updates…',
  'about.checkingShort': 'Checking…',
  'about.upToDate': 'You’re up to date.',
  'about.updateAvailable': 'Update available:',
  'about.download': 'Download',
  'about.github': 'GitHub',
  'about.documentation': 'Documentation',
  'about.checkBtn': 'Check for updates',

  // Preferences sheet (PreferencesSheet.tsx) — chrome + nav + Language.
  'prefs.title': 'Preferences',
  'prefs.search': 'Search preferences…',
  'prefs.section.integ': 'Integrations',
  'prefs.section.agents': 'Agents',
  'prefs.section.runtime': 'Runtime',
  'prefs.section.repos': 'Repositories',
  'prefs.section.git': 'Source control',
  'prefs.section.apps': 'External apps',
  'prefs.section.templates': 'Prompt templates',
  'prefs.section.reviews': 'Code reviews',
  'prefs.section.notify': 'Notifications',
  'prefs.section.permissions': 'Permissions',
  'prefs.section.language': 'Language',

  // Language preference pane.
  'language.title': 'Language',
  'language.description':
    'Choose the language PopBot uses for its interface. Most text and the menus update right away; a few system strings finish updating after a restart.',
  'language.label': 'Display language',
  'language.systemNote': 'New windows and the app menu use this language too.',
} as const;
