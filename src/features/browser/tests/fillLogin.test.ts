// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserHost } from "../agentBridge";
import type { VaultEntry } from "@/features/vault/types";

const vaultListMock = vi.fn<() => Promise<VaultEntry[]>>();
const vaultSecretForFillMock = vi.fn<(id: string, pageUrl: string) => Promise<string>>();
const vaultAllowAgentMock = vi.fn<(id: string, agent: string) => Promise<VaultEntry>>();

vi.mock("@/features/vault/ipc", () => ({
  vaultList: (...args: []) => vaultListMock(...args),
  vaultSecretForFill: (id: string, pageUrl: string) => vaultSecretForFillMock(id, pageUrl),
  vaultAllowAgent: (id: string, agent: string) => vaultAllowAgentMock(id, agent),
  vaultAdd: vi.fn(),
  vaultUpdate: vi.fn(),
  vaultRemove: vi.fn(),
  vaultRevokeAgent: vi.fn(),
}));

const confirmPromptMock = vi.fn<() => Promise<"once" | "always" | "decline">>();
vi.mock("@/features/vault/store", () => ({
  useVaultPromptStore: {
    getState: () => ({
      requestConfirm: (...args: unknown[]) => confirmPromptMock(...(args as [])),
    }),
  },
}));

const tabs = {
  views: [{ kind: "browser", id: "v-login", cwd: "/proj", url: "https://conta.exemplo.com/login", owner: { kind: "tab", id: "tab-1", label: "Claude" } }],
  portalViews: [],
  activeViewId: "v-login",
  keepMounted: vi.fn(),
  openBrowser: vi.fn(),
};
vi.mock("@/features/tabs/viewStore", () => ({ useViewTabsStore: { getState: () => tabs } }));

import { registerBrowserHost, runBrowserRequest } from "../agentBridge";
import { findLoginFields } from "../page/loginFields";

const SENHA = "SenhaMuitoSecreta#9988";

const ENTRY: VaultEntry = {
  id: "v-1",
  origin: "https://conta.exemplo.com",
  username: "ton@exemplo.com",
  label: "Exemplo",
  created_at: 1700000000,
  last_used_at: null,
  allowed_agents: ["tab-1"],
};

function fakeHost(viewId: string, pageUrl: string, onCommand: (cmd: Record<string, unknown>) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const origin = new URL(pageUrl).origin;
  const host = {
    viewId,
    cwd: "/proj",
    channel: {
      run: async (command: Record<string, unknown>) => {
        sent.push(command);
        return onCommand(command);
      },
    },
    currentUrl: () => pageUrl,
    targetOrigin: () => origin,
    proxyOrigin: () => null,
    loadCount: () => 1,
    waitForLoad: async () => true,
    history: vi.fn(),
    navigate: vi.fn(async () => undefined),
    marks: () => null,
  } as unknown as BrowserHost;
  registerBrowserHost(host);
  return { host, sent };
}

beforeEach(() => {
  vaultListMock.mockReset();
  vaultSecretForFillMock.mockReset();
  vaultAllowAgentMock.mockReset();
  confirmPromptMock.mockReset();
  tabs.views[0] = {
    kind: "browser",
    id: "v-login",
    cwd: "/proj",
    url: "https://conta.exemplo.com/login",
    owner: { kind: "tab", id: "tab-1", label: "Claude" },
  };
  tabs.activeViewId = "v-login";
});

describe("browser_fill_login (cofre no navegador)", () => {
  it("preenche_usuario_e_senha_e_resultado_nao_tem_senha", async () => {
    vaultListMock.mockResolvedValueOnce([ENTRY]);
    vaultSecretForFillMock.mockResolvedValueOnce(SENHA);
    const { sent } = fakeHost("v-login", "https://conta.exemplo.com/login", (cmd) => {
      if (cmd.op === "fillLogin") return { filled: true, submitted: false };
      return undefined;
    });

    const out = await runBrowserRequest(
      "/proj",
      { op: "fillLogin", id: "v-1", submit: false },
      { kind: "tab", id: "tab-1", label: "Claude" },
    );

    expect(vaultSecretForFillMock).toHaveBeenCalledWith("v-1", "https://conta.exemplo.com/login");
    expect(sent).toContainEqual({
      op: "fillLogin",
      username: "ton@exemplo.com",
      password: SENHA,
      submit: false,
    });
    expect(out).toContain('"filled":true');
    expect(out).toContain('"submitted":false');
    expect(out).not.toContain(SENHA);
  });

  it("origem_diferente_nao_digita_nada", async () => {
    vaultListMock.mockResolvedValueOnce([ENTRY]);
    tabs.views[0] = { ...tabs.views[0], url: "https://conta.exemplo.com.evil.io/login" };
    const { sent } = fakeHost("v-login", "https://conta.exemplo.com.evil.io/login", () => ({ filled: true, submitted: false }));

    await expect(
      runBrowserRequest(
        "/proj",
        { op: "fillLogin", id: "v-1", submit: true },
        { kind: "tab", id: "tab-1", label: "Claude" },
      ),
    ).rejects.toThrow(/origin_mismatch/i);

    expect(vaultSecretForFillMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("submit_envia_o_formulario", async () => {
    vaultListMock.mockResolvedValueOnce([ENTRY]);
    vaultSecretForFillMock.mockResolvedValueOnce(SENHA);
    const { sent } = fakeHost("v-login", "https://conta.exemplo.com/login", (cmd) => {
      if (cmd.op === "fillLogin") return { filled: true, submitted: Boolean(cmd.submit) };
      return undefined;
    });

    const out = await runBrowserRequest(
      "/proj",
      { op: "fillLogin", id: "v-1", submit: true },
      { kind: "tab", id: "tab-1", label: "Claude" },
    );

    expect(sent).toContainEqual({
      op: "fillLogin",
      username: "ton@exemplo.com",
      password: SENHA,
      submit: true,
    });
    expect(out).toContain('"filled":true');
    expect(out).toContain('"submitted":true');
    expect(out).not.toContain(SENHA);
  });

  it("primeiro_uso_pede_confirmacao_e_sempre_permitir_grava_allow_agent", async () => {
    const entryWithoutAllow: VaultEntry = { ...ENTRY, allowed_agents: [] };
    vaultListMock.mockResolvedValueOnce([entryWithoutAllow]);
    confirmPromptMock.mockResolvedValueOnce("always");
    vaultAllowAgentMock.mockResolvedValueOnce(ENTRY);
    vaultSecretForFillMock.mockResolvedValueOnce(SENHA);
    const { sent } = fakeHost("v-login", "https://conta.exemplo.com/login", () => ({ filled: true, submitted: false }));

    const out = await runBrowserRequest(
      "/proj",
      { op: "fillLogin", id: "v-1" },
      { kind: "tab", id: "tab-1", label: "Claude" },
    );

    expect(confirmPromptMock).toHaveBeenCalledTimes(1);
    expect(vaultAllowAgentMock).toHaveBeenCalledWith("v-1", "tab-1");
    expect(sent).toHaveLength(1);
    expect(out).not.toContain(SENHA);
  });

  it("recusa_do_usuario_retorna_declined_sem_digitar", async () => {
    const entryWithoutAllow: VaultEntry = { ...ENTRY, allowed_agents: [] };
    vaultListMock.mockResolvedValueOnce([entryWithoutAllow]);
    confirmPromptMock.mockResolvedValueOnce("decline");
    const { sent } = fakeHost("v-login", "https://conta.exemplo.com/login", () => ({ filled: true, submitted: false }));

    await expect(
      runBrowserRequest(
        "/proj",
        { op: "fillLogin", id: "v-1" },
        { kind: "tab", id: "tab-1", label: "Claude" },
      ),
    ).rejects.toThrow(/declined/i);

    expect(vaultSecretForFillMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("acha_campo_de_usuario_por_autocomplete_ou_antes_do_password", () => {
    document.body.innerHTML = `
      <form id="f1">
        <input id="busca" type="search" />
        <input id="email" type="text" autocomplete="username" />
        <input id="pass" type="password" />
        <button type="submit">Entrar</button>
      </form>
    `;
    const first = findLoginFields(document);
    expect(first?.username?.id).toBe("email");
    expect(first?.password.id).toBe("pass");

    document.body.innerHTML = `
      <form id="f2">
        <input id="login" type="text" name="user" />
        <input id="pw" type="password" />
      </form>
    `;
    const second = findLoginFields(document);
    expect(second?.username?.id).toBe("login");
    expect(second?.password.id).toBe("pw");
  });
});
