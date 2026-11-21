// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserHost } from "../agentBridge";
import type { VaultEntry } from "@/features/vault/types";

const vaultListMock = vi.fn<() => Promise<VaultEntry[]>>();
const vaultSecretForFillMock = vi.fn<(id: string, pageUrl: string) => Promise<string>>();

vi.mock("@/features/vault/ipc", () => ({
  vaultList: (...args: []) => vaultListMock(...args),
  vaultSecretForFill: (id: string, pageUrl: string) => vaultSecretForFillMock(id, pageUrl),
  vaultAllowAgent: vi.fn(),
  vaultAdd: vi.fn(),
  vaultUpdate: vi.fn(),
  vaultRemove: vi.fn(),
  vaultRevokeAgent: vi.fn(),
}));

vi.mock("@/features/vault/store", () => ({
  useVaultPromptStore: {
    getState: () => ({
      requestConfirm: vi.fn(async () => "once"),
    }),
  },
}));

const tabs = {
  views: [{ kind: "browser", id: "v-shield", cwd: "/proj", url: "https://conta.exemplo.com/login", owner: { kind: "tab", id: "tab-1", label: "Claude" } }],
  portalViews: [],
  activeViewId: "v-shield",
  keepMounted: vi.fn(),
  openBrowser: vi.fn(),
};
vi.mock("@/features/tabs/viewStore", () => ({ useViewTabsStore: { getState: () => tabs } }));

import { registerBrowserHost, runBrowserRequest } from "../agentBridge";
import { redactForAgent } from "../egressPolicy";
import { maskPasswordInText } from "../vaultShield";

const SENHA = "SenhaBlindada!2026$";
const OWNER = { kind: "tab" as const, id: "tab-1", label: "Claude" };
const SHIELD_MSG = "Esta aba tem uma senha do cofre preenchida. Peça ao usuário.";

const ENTRY: VaultEntry = {
  id: "v-1",
  origin: "https://conta.exemplo.com",
  username: "ton@exemplo.com",
  label: "Exemplo",
  created_at: 1700000000,
  last_used_at: null,
  allowed_agents: ["tab-1"],
};

function makeHost(viewId: string, initialUrl: string, onCommand?: (cmd: Record<string, unknown>) => unknown) {
  let current = initialUrl;
  let loads = 1;
  const sent: Record<string, unknown>[] = [];
  const historyCalls: string[] = [];

  const host = {
    viewId,
    cwd: "/proj",
    channel: {
      run: async (command: Record<string, unknown>) => {
        sent.push(command);
        if (onCommand) return onCommand(command);
        if (command.op === "fillLogin") return { filled: true, submitted: false };
        if (command.op === "eval") return "ok-eval";
        if (command.op === "snapshot") return `page: "Login" ${current}\n- textbox "Senha" [ref=e2] value="${SENHA}"`;
        if (command.op === "describe") {
          return {
            ref: "e2",
            role: "textbox",
            name: "Senha",
            tag: "input",
            selector: "#pw",
            states: [],
            value: SENHA,
            text: "",
            components: [],
            ancestors: [],
            attributes: { type: "password", value: SENHA },
            classes: [],
            box: { x: 0, y: 0, width: 100, height: 30, visible: true, covered: null },
            viewport: { width: 1280, height: 800 },
            styles: {},
            html: `<input id="pw" type="password" value="${SENHA}">`,
            url: current,
          };
        }
        return { ok: true };
      },
    },
    currentUrl: () => current,
    targetOrigin: () => {
      try {
        return new URL(current).origin;
      } catch {
        return null;
      }
    },
    proxyOrigin: () => "http://127.0.0.1:41234",
    loadCount: () => loads,
    waitForLoad: vi.fn(async () => {
      loads += 1;
      return true;
    }),
    history: vi.fn((action: "back" | "forward" | "reload") => {
      historyCalls.push(action);
      if (action === "reload") loads += 1;
    }),
    navigate: vi.fn(async (url: string) => {
      current = url;
      loads += 1;
    }),
    debugOpen: () => true,
    openNetworkDebug: vi.fn(),
    marks: () => null,
  } as unknown as BrowserHost;

  registerBrowserHost(host);
  return {
    host,
    sent,
    historyCalls,
    setUrl: (url: string) => {
      current = url;
      tabs.views[0] = { ...tabs.views[0], url };
    },
  };
}

let seq = 0;

beforeEach(() => {
  seq += 1;
  vaultListMock.mockReset();
  vaultSecretForFillMock.mockReset();
  const id = `v-shield-${seq}`;
  tabs.views[0] = {
    kind: "browser",
    id,
    cwd: "/proj",
    url: "https://conta.exemplo.com/login",
    owner: OWNER,
  };
  tabs.activeViewId = id;
});

async function fillNow(viewId: string) {
  vaultListMock.mockResolvedValueOnce([ENTRY]);
  vaultSecretForFillMock.mockResolvedValueOnce(SENHA);
  await runBrowserRequest("/proj", { op: "fillLogin", id: "v-1" }, OWNER);
  return viewId;
}

describe("blindagem da aba com senha do cofre (A3)", () => {
  it("eval_em_aba_protegida_e_recusado", async () => {
    const viewId = tabs.views[0].id;
    const { sent } = makeHost(viewId, "https://conta.exemplo.com/login");
    await fillNow(viewId);
    sent.length = 0;

    await expect(
      runBrowserRequest(
        "/proj",
        { op: "eval", code: "document.querySelector('input[type=password]').value" },
        OWNER,
      ),
    ).rejects.toThrow(SHIELD_MSG);
    expect(sent).toHaveLength(0);
  });

  it("mock_console_storage_network_recusados", async () => {
    const viewId = tabs.views[0].id;
    const { sent } = makeHost(viewId, "https://conta.exemplo.com/login");
    await fillNow(viewId);
    sent.length = 0;

    for (const req of [
      { op: "mock", action: "add", url: "/api/login", status: 200, body: "{}" },
      { op: "console" },
      { op: "storage", action: "list" },
      { op: "network" },
      { op: "network", request: "p1" },
    ]) {
      await expect(runBrowserRequest("/proj", req, OWNER)).rejects.toThrow(SHIELD_MSG);
    }
    expect(sent).toHaveLength(0);
  });

  it("navegar_para_javascript_recusado", async () => {
    const viewId = tabs.views[0].id;
    const { host } = makeHost(viewId, "https://conta.exemplo.com/login");

    await expect(
      runBrowserRequest("/proj", { op: "navigate", url: "javascript:alert(document.querySelector('input[type=password]').value)" }, OWNER),
    ).rejects.toThrow(/recusad|bloquead|não é permitid/i);

    await expect(
      runBrowserRequest("/proj", { op: "navigate", url: "data:text/html,<script>alert(1)</script>" }, OWNER),
    ).rejects.toThrow(/recusad|bloquead|não é permitid/i);

    expect(host.navigate).not.toHaveBeenCalled();
  });

  it("snapshot_mascara_senha", async () => {
    const viewId = tabs.views[0].id;
    makeHost(viewId, "https://conta.exemplo.com/login");
    await fillNow(viewId);

    const snap = await runBrowserRequest("/proj", { op: "snapshot" }, OWNER);
    expect(snap).not.toContain(SENHA);
    expect(snap).toContain("••••");

    const desc = await runBrowserRequest("/proj", { op: "describe", target: "#pw" }, OWNER);
    expect(desc).not.toContain(SENHA);
    expect(desc).toContain("••••");

    // Também garante o helper de máscara diretamente para input[type=password].
    expect(maskPasswordInText('value="segredo"', true)).toBe('value="••••"');
  });

  it("aba_suja_recarrega_antes_de_preencher", async () => {
    const viewId = tabs.views[0].id;
    const { historyCalls, sent } = makeHost(viewId, "https://conta.exemplo.com/login");

    // Agente planta um script via eval antes do preenchimento.
    await runBrowserRequest("/proj", { op: "eval", code: "window.__roubar = 1" }, OWNER);
    expect(historyCalls).toHaveLength(0);

    await fillNow(viewId);

    // A página teve que ser recarregada antes do fillLogin.
    expect(historyCalls).toContain("reload");
    const fillCmd = sent.find((c) => c.op === "fillLogin");
    expect(fillCmd).toBeDefined();
  });

  it("resultado_com_senha_vira_cofre", async () => {
    const viewId = tabs.views[0].id;
    makeHost(viewId, "https://conta.exemplo.com/login", (cmd) => {
      if (cmd.op === "fillLogin") return { filled: true, submitted: false };
      if (cmd.op === "layout") return `eco do segredo: ${SENHA}`;
      return { ok: true };
    });
    await fillNow(viewId);

    const out = await runBrowserRequest("/proj", { op: "layout" }, OWNER);
    expect(out).not.toContain(SENHA);
    expect(out).toContain("[cofre]");

    // Também cobre `redactForAgent` diretamente (mesmo em origem local).
    const redactedLocal = redactForAgent("response-body", "http://localhost:3000", `token=${SENHA}`);
    expect(redactedLocal).not.toContain(SENHA);
    expect(redactedLocal).toContain("[cofre]");
  });

  it("protecao_cai_ao_mudar_de_origem", async () => {
    const viewId = tabs.views[0].id;
    const { setUrl } = makeHost(viewId, "https://conta.exemplo.com/login");
    await fillNow(viewId);

    // Na mesma origem, eval continua recusado.
    await expect(
      runBrowserRequest("/proj", { op: "eval", code: "1 + 1" }, OWNER),
    ).rejects.toThrow(SHIELD_MSG);

    // Ao mudar de origem, a proteção da aba cai.
    setUrl("https://outro-site.exemplo.org/dashboard");
    const out = await runBrowserRequest("/proj", { op: "eval", code: "1 + 1" }, OWNER);
    expect(out).toContain("ok-eval");
  });
});
