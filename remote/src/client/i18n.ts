export type RemoteLocale = "en" | "zh-CN";

const LOCALE_STORAGE_KEY = "wispterm.remote.locale";

export function isRemoteLocale(value: unknown): value is RemoteLocale {
  return value === "en" || value === "zh-CN";
}

export function resolveLocale(saved: unknown, browserLanguage = ""): RemoteLocale {
  if (isRemoteLocale(saved)) return saved;
  return /^zh(?:-|$)/i.test(browserLanguage) ? "zh-CN" : "en";
}

function readSavedLocale(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

let locale = resolveLocale(readSavedLocale(), typeof window === "undefined" ? "" : window.navigator.language);

export function getLocale(): RemoteLocale {
  return locale;
}

export function tr(english: string, simplifiedChinese: string): string {
  return locale === "zh-CN" ? simplifiedChinese : english;
}

export function initializeLocale(): void {
  document.documentElement.lang = locale;
  document.title = tr("WispTerm Remote", "WispTerm 远程终端");
}

export function setLocale(value: RemoteLocale): boolean {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    return false;
  }
  locale = value;
  initializeLocale();
  return true;
}
