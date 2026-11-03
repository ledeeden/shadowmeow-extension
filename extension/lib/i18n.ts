export type InterfaceLanguage = 'system' | 'zh-CN' | 'zh-TW' | 'en';
export type InterfaceLocale = 'zh-CN' | 'zh-TW' | 'en';
export const LANGUAGE_STORAGE_KEY = 'shadow-language:interface-language';
const catalogs: Partial<Record<InterfaceLocale, Record<string, string>>> = {};

export async function loadInterfaceMessages(locale = interfaceLocale()): Promise<void> {
  if (locale === 'zh-CN' || catalogs[locale]) return;
  catalogs[locale] = locale === 'en'
    ? (await import('./locales/en')).english
    : (await import('./locales/zh-TW.json')).default;
}

export function resolveInterfaceLocale(preference: InterfaceLanguage, languages: readonly string[]): InterfaceLocale {
  if (preference !== 'system') return preference;
  // The first preferred system language determines the UI; other languages use English.
  const language = (languages[0] || '').toLowerCase();
  if (!/^zh(?:-|$)/.test(language)) return 'en';
  if (language.includes('-hans')) return 'zh-CN';
  if (language.includes('-hant') || /-(tw|hk|mo)(-|$)/.test(language)) return 'zh-TW';
  return 'zh-CN';
}

export function readInterfaceLanguage(): InterfaceLanguage {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (value === 'en' || value === 'zh-CN' || value === 'zh-TW') return value;
  } catch { /* Private browsing can disable storage. */ }
  return 'system';
}

export function interfaceLocale(): InterfaceLocale {
  // Shared components retain their existing extension behavior.
  if (!import.meta.env?.VITE_SHADOW_WEB) return 'zh-CN';
  return resolveInterfaceLocale(readInterfaceLanguage(), typeof navigator === 'undefined' ? ['en'] : navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function translate(source: string, locale: InterfaceLocale, ...values: Array<string | number | undefined>): string {
  const message = catalogs[locale]?.[source] ?? source;
  return message.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);
}

// UI language changes reload the app, so messages and module-level labels share one locale.
const activeLocale = interfaceLocale();
export function t(source: string, ...values: Array<string | number | undefined>): string {
  return translate(source, activeLocale, ...values);
}

export function setInterfaceLanguage(preference: InterfaceLanguage): void {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  // Reload also refreshes module-level navigation labels and locale-dependent caches.
  window.location.reload();
}

export function initializeInterfaceLanguage(): () => void {
  const locale = interfaceLocale();
  document.documentElement.lang = locale;
  document.title = translate('Shadow Language · 用英语探索世界', locale);
  // The legal footer is static HTML outside React's root.
  const footer = document.querySelector('.site-legal-footer');
  footer?.setAttribute('aria-label', translate('网站信息', locale));
  footer?.querySelectorAll('a').forEach(link => {
    if (link.textContent) link.textContent = translate(link.textContent, locale);
  });
  const refresh = () => { if (interfaceLocale() !== locale) window.location.reload(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) refresh();
  };
  window.addEventListener('languagechange', refresh);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('languagechange', refresh);
    window.removeEventListener('storage', onStorage);
  };
}
