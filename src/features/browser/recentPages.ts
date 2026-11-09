/** Histórico curto da página inicial, separado por perfil do navegador. */

export interface RecentBrowserPage {
  url: string;
  title: string;
  visitedAt: number;
}

const KEY_PREFIX = "cc-browser-recent-v1:";
export const MAX_RECENT_BROWSER_PAGES = 8;

function storageKey(profileId: string): string {
  return `${KEY_PREFIX}${profileId}`;
}

function safeRecentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Não persiste credenciais, parâmetros de login nem fragments de sessão.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function parsePages(value: unknown): RecentBrowserPage[] {
  if (!Array.isArray(value)) return [];
  const pages: RecentBrowserPage[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { url?: unknown; title?: unknown; visitedAt?: unknown };
    const url = safeRecentUrl(row.url);
    if (!url || seen.has(url)) continue;
    const title = typeof row.title === "string" ? row.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
    const visitedAt = typeof row.visitedAt === "number" && Number.isFinite(row.visitedAt) ? row.visitedAt : 0;
    pages.push({ url, title: title || new URL(url).host, visitedAt });
    seen.add(url);
    if (pages.length >= MAX_RECENT_BROWSER_PAGES) break;
  }
  return pages;
}

export function readRecentBrowserPages(profileId: string): RecentBrowserPage[] {
  try {
    return parsePages(JSON.parse(localStorage.getItem(storageKey(profileId)) ?? "[]"));
  } catch {
    return [];
  }
}

export function rememberRecentBrowserPage(
  profileId: string,
  url: string,
  title: string,
  visitedAt = Date.now(),
): RecentBrowserPage[] {
  const safeUrl = safeRecentUrl(url);
  if (!safeUrl) return readRecentBrowserPages(profileId);
  const safeTitle = title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || new URL(safeUrl).host;
  const pages = [
    { url: safeUrl, title: safeTitle, visitedAt },
    ...readRecentBrowserPages(profileId).filter((page) => page.url !== safeUrl),
  ].slice(0, MAX_RECENT_BROWSER_PAGES);
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify(pages));
  } catch {
    // O histórico é só um atalho; a página continua utilizável se o storage estiver cheio.
  }
  return pages;
}

export function clearRecentBrowserPages(profileId: string): void {
  try {
    localStorage.removeItem(storageKey(profileId));
  } catch {
    // Limpar o histórico não interfere na navegação.
  }
}
