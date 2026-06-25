/**
 * Framework-agnostic i18n core, shared by the Electron main process and
 * the React renderer. No DOM / React / Node dependencies — pure data +
 * functions so it bundles cleanly into both processes and is trivially
 * unit-testable under Vitest's node environment.
 *
 * Renderer integration: see `src/renderer/src/lib/i18n.tsx`.
 * Main integration:     see `installAppMenu()` in `src/main/index.ts`.
 */
import { en } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { de } from './messages/de';
import { ja } from './messages/ja';
import { ko } from './messages/ko';
import { zhCN } from './messages/zh-CN';
import { ptBR } from './messages/pt-BR';
import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type MessageKey,
  type PartialMessages,
  type TranslationParams,
} from './types';

export {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type LocaleMeta,
  type MessageKey,
  type TranslationParams,
} from './types';

/** Lookup table: locale code → its (possibly partial) catalog. English
 *  is complete; every other locale falls back to English per-key. */
const CATALOGS: Record<Locale, PartialMessages> = {
  en,
  es,
  fr,
  de,
  ja,
  ko,
  'zh-CN': zhCN,
  'pt-BR': ptBR,
};

/** Settings key under which the chosen locale is persisted (SQLite
 *  `settings` table). Shared so main + renderer read/write the same key. */
export const LOCALE_SETTING_KEY = 'locale';

const SUPPORTED = new Set<string>(LOCALES.map((l) => l.code));

/** True when `code` is one of our supported locale tags. */
export function isSupportedLocale(code: unknown): code is Locale {
  return typeof code === 'string' && SUPPORTED.has(code);
}

/**
 * Best-effort resolution of an arbitrary locale-ish string (e.g. from
 * persisted settings, `navigator.language`, or `app.getLocale()`) to one
 * of our supported locales.
 *   - exact match wins ('pt-BR' → 'pt-BR')
 *   - otherwise the base language is tried ('pt-PT' → 'pt'?; 'fr-CA' → 'fr')
 *   - falls back to the default locale (English) when nothing matches.
 */
export function resolveLocale(input: unknown): Locale {
  if (typeof input !== 'string' || input.length === 0) return DEFAULT_LOCALE;
  if (isSupportedLocale(input)) return input;
  const base = input.split('-')[0].toLowerCase();
  // Prefer an exact base-language locale ('fr-CA' → 'fr').
  if (isSupportedLocale(base)) return base;
  // Otherwise the first supported locale sharing that base ('zh' → 'zh-CN').
  const sharing = LOCALES.find((l) => l.code.split('-')[0].toLowerCase() === base);
  return sharing ? sharing.code : DEFAULT_LOCALE;
}

/** Substitute `{name}` placeholders in `template` from `params`. Unknown
 *  placeholders are left intact so a missing param is visible, not silent. */
function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/**
 * Translate a single key for `locale`, falling back to English for any
 * key the locale doesn't define, then to the raw key itself (so a typo'd
 * or not-yet-added key is visible in the UI rather than rendering blank).
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: TranslationParams,
): string {
  const catalog = CATALOGS[locale] ?? en;
  const template = catalog[key] ?? en[key] ?? key;
  return interpolate(template, params);
}

/** A bound translator for a fixed locale — `const t = createTranslator('fr')`. */
export type Translator = (key: MessageKey, params?: TranslationParams) => string;

export function createTranslator(locale: Locale): Translator {
  const resolved = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  return (key, params) => translate(resolved, key, params);
}

/** The raw catalog for a locale (English-backed). Exposed mainly for tests. */
export function catalogFor(locale: Locale): PartialMessages {
  return CATALOGS[locale] ?? en;
}
