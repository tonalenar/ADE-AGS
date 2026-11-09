import { normalizeUrl } from "@/features/tabs/viewTabs";

export const BROWSER_SEARCH_PREFERENCES_KEY = "cc-browser-search-v1";

export type BrowserSearchEngine = "duckduckgo" | "google" | "bing" | "brave" | "kagi" | "ecosia" | "custom";
export type BrowserLinkTarget = "system" | "app";

export interface BrowserSearchPreferences {
  engine: BrowserSearchEngine;
  customUrl: string;
  linkTarget: BrowserLinkTarget;
}

export const DEFAULT_BROWSER_SEARCH_PREFERENCES: BrowserSearchPreferences = {
  engine: "duckduckgo",
  customUrl: "",
  linkTarget: "system",
};

const ENGINES = new Set<BrowserSearchEngine>(["duckduckgo", "google", "bing", "brave", "kagi", "ecosia", "custom"]);
const BUILT_IN_SEARCH_URLS: Record<Exclude<BrowserSearchEngine, "custom">, string> = {
  duckduckgo: "https://duckduckgo.com/",
  google: "https://www.google.com/search",
  bing: "https://www.bing.com/search",
  brave: "https://search.brave.com/search",
  kagi: "https://kagi.com/search",
  ecosia: "https://www.ecosia.org/search",
};

function validHttpUrl(input: string): boolean {
  try {
    const url = new URL(input.replace(/%s/g, "query"));
    return (url.protocol === "https:" || url.protocol === "http:")
      && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function readBrowserSearchPreferences(): BrowserSearchPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(BROWSER_SEARCH_PREFERENCES_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_BROWSER_SEARCH_PREFERENCES;
    const candidate = raw as { engine?: unknown; customUrl?: unknown; linkTarget?: unknown };
    const engine = typeof candidate.engine === "string" && ENGINES.has(candidate.engine as BrowserSearchEngine)
      ? candidate.engine as BrowserSearchEngine : "duckduckgo";
    const customUrl = typeof candidate.customUrl === "string" ? candidate.customUrl.trim() : "";
    if (engine === "custom" && !isValidCustomSearchUrl(customUrl)) {
      return { ...DEFAULT_BROWSER_SEARCH_PREFERENCES, engine: "duckduckgo" };
    }
    const linkTarget: BrowserLinkTarget = candidate.linkTarget === "app" ? "app" : "system";
    return { engine, customUrl, linkTarget };
  } catch {
    return DEFAULT_BROWSER_SEARCH_PREFERENCES;
  }
}

export function isValidCustomSearchUrl(template: string): boolean {
  return template.length <= 2048 && template.includes("%s") && validHttpUrl(template);
}

export function saveBrowserSearchPreferences(preferences: BrowserSearchPreferences): void {
  const customUrl = preferences.customUrl.trim();
  if (!ENGINES.has(preferences.engine)
    || (preferences.linkTarget !== "app" && preferences.linkTarget !== "system")
    || (preferences.engine === "custom" && !isValidCustomSearchUrl(customUrl))) {
    throw new Error("invalid-search-template");
  }
  try {
    localStorage.setItem(BROWSER_SEARCH_PREFERENCES_KEY, JSON.stringify({ ...preferences, customUrl }));
  } catch {
    throw new Error("storage");
  }
}

export function browserSearchUrl(query: string, preferences = readBrowserSearchPreferences()): string | null {
  const text = query.trim();
  if (!text) return null;
  if (preferences.engine === "custom") {
    if (!isValidCustomSearchUrl(preferences.customUrl)) return null;
    const url = preferences.customUrl.replace(/%s/g, encodeURIComponent(text));
    return validHttpUrl(url) ? url : null;
  }
  const url = new URL(BUILT_IN_SEARCH_URLS[preferences.engine]);
  url.searchParams.set("q", text);
  return url.href;
}

/** Resolve texto digitado na barra como endereço HTTP(S) ou como uma busca. */
export function resolveBrowserAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  // Consultas com espaços são buscas mesmo quando começam por algo que parece domínio.
  if (/\s/.test(text)) return browserSearchUrl(text);

  const isHostPort = /^[a-z0-9.-]+:\d+(?:[/?#].*)?$/i.test(text);
  const hasUnsupportedScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text) && !isHostPort;
  if (hasUnsupportedScheme) return null;

  const normalized = normalizeUrl(text);
  if (!normalized) return browserSearchUrl(text);
  try {
    const url = new URL(normalized);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // Entrada que parece endereço, mas não pode ser convertida em HTTP(S).
  }
  return null;
}
