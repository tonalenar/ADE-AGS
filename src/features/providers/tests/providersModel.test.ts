import { describe, expect, it } from "vitest";

import type { AccountHealth, AgentAccount } from "@/features/accounts/types";

import { accountIdentity, parseDisabled, providerStatus, signInMethods, versionLabel, withEnabled } from "../providersModel";

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({
  id: "a1", agentId: "claude-code", name: "trabalho", dir: "/x", envVar: "CLAUDE_CONFIG_DIR", loginCommand: "claude",
  loggedIn: true, label: "ana@exemplo.com", createdAt: 1, kind: "login", baseUrl: null, keyHint: null, ...over,
});
const health = (over: Partial<AccountHealth>): AccountHealth => ({ status: "ok", detail: "", email: null, plan: null, checkedAt: 1, ...over });
const base = { installed: true, enabled: true, supportsAccounts: true, accounts: [account()], health: {} };

describe("providerStatus", () => {
  it("segue a ordem do T3: desativado, não achado, sem login, autenticado", () => {
    expect(providerStatus({ ...base, enabled: false }).tone).toBe("disabled");
    expect(providerStatus({ ...base, installed: false }).key).toBe("providers.status.notFound");
    expect(providerStatus({ ...base, accounts: [account({ loggedIn: false })] }).key).toBe("providers.status.notAuthenticated");
    expect(providerStatus(base)).toEqual({ tone: "ready", key: "providers.status.authenticated", vars: { label: "ana@exemplo.com", extra: 0 } });
  });

  it("agentes sem conta separada ficam 'disponível', sem afirmar login", () => {
    expect(providerStatus({ ...base, supportsAccounts: false, accounts: [] }).key).toBe("providers.status.available");
  });

  it("conta extra aparece como +N e a identidade vem da CLI quando ela disse", () => {
    const two = [account(), account({ id: "a2", name: "pessoal", label: null })];
    const status = providerStatus({ ...base, accounts: two, health: { a1: health({ email: "x@y.z", plan: "max" }) } });
    expect(status.key).toBe("providers.status.authenticatedMore");
    expect(status.vars).toEqual({ label: "x@y.z · max", extra: 1 });
  });

  it("login recusado pela verificação vira erro; 'desconhecido' não derruba o que o disco diz", () => {
    expect(providerStatus({ ...base, health: { a1: health({ status: "invalid" }) } }).tone).toBe("error");
    expect(providerStatus({ ...base, health: { a1: health({ status: "unknown" }) } }).tone).toBe("ready");
    expect(providerStatus({ ...base, health: { a1: health({ status: "not_logged_in" }) } }).tone).toBe("warning");
  });
});

describe("accountIdentity / versionLabel", () => {
  it("cai do e-mail verificado para o rótulo e para o nome", () => {
    expect(accountIdentity(account({ label: null }))).toBe("trabalho");
    expect(accountIdentity(account(), "checking")).toBe("ana@exemplo.com");
  });
  it("extrai a versão do texto da CLI", () => {
    expect(versionLabel("1.5.5")).toBe("v1.5.5");
    expect(versionLabel("2.1.0 (Claude Code)")).toBe("v2.1.0");
    expect(versionLabel("dev")).toBe("dev");
    expect(versionLabel(undefined)).toBeNull();
  });
});

describe("signInMethods", () => {
  it("Claude e Codex oferecem login e chave de API", () => {
    expect(signInMethods("claude-code", true).map((m) => [m.id, m.available])).toEqual([["login", true], ["api_key", true]]);
    expect(signInMethods("codex", true).map((m) => m.id)).toEqual(["login", "api_key"]);
  });

  it("o Antigravity só entra por conta Google; as chaves aparecem indisponíveis, com o motivo", () => {
    const methods = signInMethods("antigravity", true);
    expect(methods.map((m) => [m.id, m.available])).toEqual([["login", true], ["gemini_api_key", false], ["agent_platform", false]]);
    expect(methods.filter((m) => !m.available).every((m) => m.whyKey === "providers.method.unavailable.agy")).toBe(true);
  });

  it("sem perfil de conta (fora do macOS) até o login Google fica indisponível", () => {
    const login = signInMethods("antigravity", false)[0];
    expect(login).toMatchObject({ id: "login", available: false, whyKey: "providers.method.unavailable.os" });
  });

  it("agentes desconhecidos não têm formas de entrada", () => {
    expect(signInMethods("gemini-cli", false)).toEqual([]);
  });
});

describe("lista de desativados", () => {
  it("tolera lixo guardado", () => {
    expect(parseDisabled(null)).toEqual([]);
    expect(parseDisabled("{")).toEqual([]);
    expect(parseDisabled('{"a":1}')).toEqual([]);
    expect(parseDisabled('["codex", 3, "", "codex", "cursor"]')).toEqual(["codex", "cursor"]);
  });
  it("liga e desliga sem duplicar", () => {
    expect(withEnabled([], "codex", false)).toEqual(["codex"]);
    expect(withEnabled(["codex"], "codex", false)).toEqual(["codex"]);
    expect(withEnabled(["codex", "cursor"], "codex", true)).toEqual(["cursor"]);
  });
});
