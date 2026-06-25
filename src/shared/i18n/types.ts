import { en } from './messages/en';

/**
 * Supported UI locales for the localization MVP. English is the base /
 * fallback; the rest were chosen as the FIGS + CJK + PT-BR set covering
 * the highest-value developer-tool markets.
 *
 * `code` is a BCP-47 tag. `nativeName` is shown in the language picker in
 * the user's own language (never translated). `englishName` is for logs /
 * accessibility fallbacks.
 */
export interface LocaleMeta {
  code: Locale;
  nativeName: string;
  englishName: string;
}

export const LOCALES = [
  { code: 'en', nativeName: 'English', englishName: 'English' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish' },
  { code: 'fr', nativeName: 'Français', englishName: 'French' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean' },
  { code: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)' },
] as const satisfies readonly LocaleMeta[];

export type Locale =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'ja'
  | 'ko'
  | 'zh-CN'
  | 'pt-BR';

export const DEFAULT_LOCALE: Locale = 'en';

/** The set of valid message keys, derived from the English catalog. */
export type MessageKey = keyof typeof en;

/** A complete message catalog. Only English is required to be complete. */
export type Messages = Record<MessageKey, string>;

/** A translation catalog for a non-base locale — any subset of keys;
 *  missing keys fall back to English at lookup time. */
export type PartialMessages = Partial<Messages>;

/** Values supplied for `{placeholder}` interpolation. */
export type TranslationParams = Record<string, string | number>;
