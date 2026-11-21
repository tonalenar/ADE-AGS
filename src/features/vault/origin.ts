/**
 * Validação de origem do cofre no frontend (espelha `src-tauri/src/vault/mod.rs`).
 *
 * O backend também valida antes de entregar a senha; validar aqui impede abrir o cartão
 * de confirmação ou acionar o navegador quando a página está em outra origem.
 */

const COMPOUND_PUBLIC_SUFFIXES = new Set([
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp", "com.ar", "com.mx", "com.es",
  "co.nz", "co.in", "com.cn", "com.tw", "com.hk", "com.sg", "co.kr", "co.za", "com.tr",
  "com.pl", "com.pt",
]);

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isValidWildcardDomain(domain: string): boolean {
  if (!domain || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) || domain.includes(":")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (labels.length === 2 && COMPOUND_PUBLIC_SUFFIXES.has(domain)) return false;
  return labels.every((label) =>
    label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")
    && /^[a-z0-9-]+$/.test(label),
  );
}

function parseWildcard(raw: string): { domain: string; port: string } | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://*.")) return null;
  let rest: string | null = null;
  if (trimmed.startsWith("*.")) rest = trimmed.slice(2);
  else if (lower.startsWith("https://*.")) rest = trimmed.slice("https://*.".length);
  if (rest === null) return null;

  try {
    const parsed = new URL(`https://wildcard.${rest}`);
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host.startsWith("wildcard.")) return null;
    const domain = host.slice("wildcard.".length);
    if (!isValidWildcardDomain(domain)) return null;
    return { domain, port: parsed.port };
  } catch {
    return null;
  }
}

export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const wildcard = parseWildcard(trimmed);
  if (wildcard) {
    return `*.${wildcard.domain}${wildcard.port ? `:${wildcard.port}` : ""}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host) return null;
    const scheme = parsed.protocol.slice(0, -1);
    if (scheme !== "https" && !(scheme === "http" && isLocalHost(host))) return null;
    return `${scheme}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

export function originMatches(entryOrigin: string, pageUrl: string): boolean {
  let page: URL;
  try {
    page = new URL(pageUrl.trim());
  } catch {
    return false;
  }
  if (page.username || page.password) return false;
  const pageHost = page.hostname.toLowerCase();
  const pageScheme = page.protocol.slice(0, -1);

  const wildcard = parseWildcard(entryOrigin);
  if (wildcard) {
    if (pageScheme !== "https") return false;
    if (page.port !== wildcard.port) return false;
    return pageHost === wildcard.domain || pageHost.endsWith(`.${wildcard.domain}`);
  }

  const expected = normalizeOrigin(entryOrigin);
  const actual = normalizeOrigin(pageUrl);
  return expected !== null && actual !== null && expected === actual;
}
