/**
 * A lógica da importação de cookies do Firefox, sem React (testada em `tests/browserImportModel.test.ts`).
 * A revisão só traz domínios e contagens: os valores dos cookies nunca chegam à interface.
 */
import type { BrowserImportDomain, BrowserImportFailure } from "./ipc";

/** Marcar um domínio o acrescenta; marcar de novo o tira. Não muda o conjunto recebido. */
export function toggleDomain(selected: ReadonlySet<string>, domain: string): Set<string> {
  const next = new Set(selected);
  if (next.has(domain)) next.delete(domain);
  else next.add(domain);
  return next;
}

/** Todos os domínios da revisão, marcados. */
export function selectAll(domains: readonly BrowserImportDomain[]): Set<string> {
  return new Set(domains.map((d) => d.domain));
}

/** Os domínios marcados, na ordem em que a revisão os mostra. Só esses entram na importação. */
export function selectedInOrder(domains: readonly BrowserImportDomain[], selected: ReadonlySet<string>): string[] {
  return domains.map((d) => d.domain).filter((domain) => selected.has(domain));
}

/** Sem nenhum domínio marcado, a importação não começa. */
export function canImport(selected: ReadonlySet<string>): boolean {
  return selected.size > 0;
}

/** A chave de tradução de cada recusa do backend (`preview/importer/mod.rs`). Código novo cai na genérica. */
const FAILURE_KEYS = new Map<string, string>([
  ["no-state-dir", "settings.browserImport.error.noStateDir"],
  ["no-state-key", "settings.browserImport.error.noStateKey"],
  ["no-firefox", "settings.browserImport.error.noFirefox"],
  ["no-profile", "settings.browserImport.error.noProfile"],
  ["browser-running", "settings.browserImport.error.browserRunning"],
  ["lock-unknown", "settings.browserImport.error.lockUnknown"],
  ["no-cookies", "settings.browserImport.error.noCookies"],
  ["unreadable", "settings.browserImport.error.unreadable"],
  ["no-domains", "settings.browserImport.error.noDomains"],
  ["write-failed", "settings.browserImport.error.writeFailed"],
]);

export function failureKey(code: string): string {
  return FAILURE_KEYS.get(code) ?? "settings.browserImport.error.generic";
}

/** O que o `invoke` rejeita é o erro serializado do backend; qualquer outra coisa vira a recusa genérica. */
export function asFailure(reason: unknown): BrowserImportFailure {
  if (typeof reason === "object" && reason !== null && "code" in reason && typeof reason.code === "string") {
    const detail = "detail" in reason && typeof reason.detail === "string" ? reason.detail : null;
    return { code: reason.code, detail };
  }
  return { code: "generic", detail: null };
}
