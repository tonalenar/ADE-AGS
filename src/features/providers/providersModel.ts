/**
 * Lógica pura da página Providers (Configurações): estado de cada provedor, formas de entrada e a
 * lista dos desativados. Sem React nem IPC, para testar sem DOM.
 */
import type { AccountHealth, AgentAccount } from "@/features/accounts/types";

export type ProviderTone = "ready" | "warning" | "error" | "disabled" | "neutral";

export interface ProviderStatus {
  tone: ProviderTone;
  /** Chave i18n do título ("Autenticado · …"). */
  key: string;
  vars: Record<string, string | number>;
}

export interface ProviderStatusInput {
  installed: boolean;
  enabled: boolean;
  /** O agente tem contas (perfil isolado): só então a ADE sabe dizer se há login. */
  supportsAccounts: boolean;
  /** A conta do sistema mais as criadas na ADE, deste agente. */
  accounts: AgentAccount[];
  health: Record<string, AccountHealth | "checking">;
}

/** O nome que identifica uma conta: o e-mail/plano que a CLI disse, senão o rótulo, senão o nome. */
export function accountIdentity(account: AgentAccount, health?: AccountHealth | "checking"): string {
  const checked = health && health !== "checking" ? [health.email, health.plan].filter(Boolean).join(" · ") : "";
  return checked || account.label || account.name;
}

type AccountState = "ok" | "invalid" | "off";

function accountState(account: AgentAccount, health?: AccountHealth | "checking"): AccountState {
  if (health && health !== "checking") {
    if (health.status === "ok") return "ok";
    if (health.status === "invalid") return "invalid";
    // `unknown` (sem rede, CLI ausente) não derruba o que o disco diz.
    if (health.status === "unknown") return account.loggedIn ? "ok" : "off";
    return "off";
  }
  return account.loggedIn ? "ok" : "off";
}

/** O estado do provedor, na ordem do T3: desativado, não achado, sem login, autenticado, disponível. Pura. */
export function providerStatus(input: ProviderStatusInput): ProviderStatus {
  const none = (tone: ProviderTone, key: string): ProviderStatus => ({ tone, key, vars: {} });
  if (!input.enabled) return none("disabled", "providers.status.disabled");
  if (!input.installed) return none("warning", "providers.status.notFound");
  if (!input.supportsAccounts) return none("neutral", "providers.status.available");

  const states = input.accounts.map((a) => ({ a, state: accountState(a, input.health[a.id]) }));
  const ok = states.filter((s) => s.state === "ok");
  if (ok.length > 0) {
    const label = accountIdentity(ok[0].a, input.health[ok[0].a.id]);
    const extra = Math.max(0, input.accounts.length - 1);
    return { tone: "ready", key: extra > 0 ? "providers.status.authenticatedMore" : "providers.status.authenticated", vars: { label, extra } };
  }
  if (states.some((s) => s.state === "invalid")) return none("error", "providers.status.invalid");
  return none("warning", "providers.status.notAuthenticated");
}

/** "1.5.5 (Claude Code)" → "v1.5.5". Sem número, devolve o texto como veio. Pura. */
export function versionLabel(version: string | null | undefined): string | null {
  const text = version?.trim();
  if (!text) return null;
  const match = /\d+(?:\.\d+)+(?:[-+][\w.]+)?/.exec(text);
  return match ? `v${match[0]}` : text;
}

export type SignInMethodId = "login" | "api_key" | "gemini_api_key" | "agent_platform";

export interface SignInMethod {
  id: SignInMethodId;
  /** Chave i18n do nome. */
  labelKey: string;
  available: boolean;
  /** Por que não está disponível (chave i18n). */
  whyKey?: string;
}

/**
 * As formas de entrada de cada agente (a "Sign-in method" do T3). O que a ADE não consegue entregar
 * aparece indisponível, com o motivo, em vez de sumir:
 * - Antigravity: o `agy` 1.5.5 só entra por login Google e ignora chave de API por variável (medido);
 * - login do Claude/Codex abre o fluxo oficial da CLI num terminal; a chave vai ao chaveiro do SO.
 */
export function signInMethods(agentId: string, accountCapable: boolean): SignInMethod[] {
  switch (agentId) {
    case "claude-code":
      return [
        { id: "login", labelKey: "providers.method.claude-code.login", available: true },
        { id: "api_key", labelKey: "providers.method.claude-code.api_key", available: true },
      ];
    case "codex":
      return [
        { id: "login", labelKey: "providers.method.codex.login", available: true },
        { id: "api_key", labelKey: "providers.method.codex.api_key", available: true },
      ];
    case "opencode":
      return [{ id: "login", labelKey: "providers.method.opencode.login", available: true }];
    case "antigravity":
      return [
        {
          id: "login", labelKey: "providers.method.antigravity.login", available: accountCapable,
          ...(accountCapable ? {} : { whyKey: "providers.method.unavailable.os" }),
        },
        { id: "gemini_api_key", labelKey: "providers.method.antigravity.gemini_api_key", available: false, whyKey: "providers.method.unavailable.agy" },
        { id: "agent_platform", labelKey: "providers.method.antigravity.agent_platform", available: false, whyKey: "providers.method.unavailable.agy" },
      ];
    case "cursor":
      return [{ id: "login", labelKey: "providers.method.cursor.login", available: false, whyKey: "providers.method.unavailable.cursor" }];
    default:
      return [];
  }
}

/** Chave da lista dos desativados nas configurações do app. */
export const DISABLED_KEY = "providers.disabled";

/** Lê a lista guardada, tolerando lixo (JSON quebrado, tipos errados). Pura. */
export function parseDisabled(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))] : [];
  } catch {
    return [];
  }
}

/** Liga ou desliga um provedor na lista, sem duplicar. Pura. */
export function withEnabled(disabled: readonly string[], agentId: string, enabled: boolean): string[] {
  const rest = disabled.filter((id) => id !== agentId);
  return enabled ? rest : [...rest, agentId];
}
