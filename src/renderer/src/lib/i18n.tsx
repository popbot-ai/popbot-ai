import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_SETTING_KEY,
  createTranslator,
  resolveLocale,
  type Locale,
  type MessageKey,
  type TranslationParams,
} from '@shared/i18n';

interface I18nContextValue {
  /** Active locale. */
  locale: Locale;
  /** Translate a key (with optional `{placeholder}` params). */
  t: (key: MessageKey, params?: TranslationParams) => string;
  /** Switch + persist the active locale. Also tells main to rebuild the
   *  native menu so its labels follow the renderer. */
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Loads the persisted UI locale from settings on mount (falling back to
 * the OS locale, then English), exposes a `t()` translator that re-binds
 * whenever the locale changes, and persists + broadcasts locale changes.
 *
 * Wrap the app once near the root (see `App.tsx`). Until settings load we
 * render with the OS-derived locale so there's no blank flash.
 */
export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(typeof navigator !== 'undefined' ? navigator.language : DEFAULT_LOCALE),
  );

  // Hydrate from the persisted setting once on mount.
  useEffect(() => {
    let cancelled = false;
    void window.popbot.settings.get<string>(LOCALE_SETTING_KEY).then((saved) => {
      if (cancelled || saved == null) return;
      setLocaleState(resolveLocale(saved));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep <html lang> in sync for a11y / spellcheck / CSS :lang() hooks.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    const resolved = resolveLocale(next);
    setLocaleState(resolved);
    void window.popbot.settings.set(LOCALE_SETTING_KEY, resolved);
    // Rebuild the native app menu (macOS app menu / non-mac File menu)
    // so it tracks the renderer's language without a restart.
    window.popbot.i18n?.localeChanged(resolved);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const translator = createTranslator(locale);
    return { locale, t: translator, setLocale };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the active translator + locale controls. Must be used under
 *  `<I18nProvider>`. */
export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useTranslation must be used within <I18nProvider>');
  return ctx;
}
