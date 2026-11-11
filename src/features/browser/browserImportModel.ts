/**
 * A lógica da importação de cookies de outro navegador, sem React (testada em `tests/browserImportModel.test.ts`).
 * A revisão só traz domínios e contagens: os valores dos cookies nunca chegam à interface.
 */
import type { BrowserImportDomain, BrowserImportFailure, BrowserImportSource } from "./ipc";

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
  ["no-profile", "settings.browserImport.error.noProfile"],
  ["unknown-source", "settings.browserImport.error.unknownSource"],
  ["invalid-target-profile", "settings.browserImport.error.invalidTarget"],
  ["browser-running", "settings.browserImport.error.browserRunning"],
  ["lock-unknown", "settings.browserImport.error.lockUnknown"],
  ["no-cookies", "settings.browserImport.error.noCookies"],
  ["unreadable", "settings.browserImport.error.unreadable"],
  ["no-domains", "settings.browserImport.error.noDomains"],
  ["write-failed", "settings.browserImport.error.writeFailed"],
  ["needs-full-disk-access", "settings.browserImport.error.needsFullDiskAccess"],
  ["needs-keychain-approval", "settings.browserImport.error.needsKeychainApproval"],
  ["keychain-item-missing", "settings.browserImport.error.keychainItemMissing"],
  ["keychain-unavailable", "settings.browserImport.error.keychainUnavailable"],
  ["app-bound", "settings.browserImport.error.appBound"],
  ["unsupported-platform", "settings.browserImport.error.unsupportedPlatform"],
  ["undecryptable", "settings.browserImport.error.undecryptable"],
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

/** O que o assistente mostra para uma fonte, segundo o que a impede de importar. */
export type SourceStep = "configure" | "quit" | "fullDiskAccess" | "blocked";

export function sourceStep(source: BrowserImportSource): SourceStep {
  switch (source.unavailable) {
    case null:
      return source.profiles.length === 0 ? "blocked" : "configure";
    case "browser-running":
      return "quit";
    case "needs-full-disk-access":
      return "fullDiskAccess";
    default:
      return "blocked";
  }
}

/** A frase de cada motivo de indisponibilidade de uma fonte. */
const UNAVAILABLE_KEYS = new Map<string, string>([
  ["not-installed", "settings.browserImport.source.notInstalled"],
  ["browser-running", "settings.browserImport.source.browserRunning"],
  ["needs-full-disk-access", "settings.browserImport.source.needsFullDiskAccess"],
  ["app-bound", "settings.browserImport.source.appBound"],
  ["unsupported-platform", "settings.browserImport.source.unsupportedPlatform"],
]);

export function unavailableKey(reason: string): string {
  return UNAVAILABLE_KEYS.get(reason) ?? "settings.browserImport.error.generic";
}

/** Fontes que o sistema atual nem sabe importar não entram na lista. */
export function listedSources(sources: readonly BrowserImportSource[]): BrowserImportSource[] {
  return sources.filter((source) => source.unavailable !== "unsupported-platform");
}

/** A primeira fonte pronta para importar; sem nenhuma, a primeira da lista. */
export function defaultSourceId(sources: readonly BrowserImportSource[]): string {
  return (sources.find((source) => sourceStep(source) === "configure") ?? sources[0])?.id ?? "";
}

/** O perfil de origem a manter depois de reler a lista: o atual, se ainda existe; senão, o primeiro. */
export function keepProfileId(source: BrowserImportSource | undefined, currentId: string): string {
  if (!source) return "";
  return source.profiles.some((profile) => profile.id === currentId) ? currentId : (source.profiles[0]?.id ?? "");
}

/** O Chromium guarda a chave dos cookies no chaveiro do sistema: o sistema pode pedir permissão ao gravar. */
export function needsKeyPrompt(source: BrowserImportSource): boolean {
  return source.engine === "chromium";
}
