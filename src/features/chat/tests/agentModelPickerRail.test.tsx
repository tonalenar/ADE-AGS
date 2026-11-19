// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  accounts: [] as { accountId: string | null; name: string; label: string | null; loggedIn: boolean }[],
  identities: [] as Record<string, unknown>[],
  liveCalls: [] as { accountKey: string; force: boolean }[],
  capable: [{ agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true }] as Record<string, unknown>[],
  dialogs: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: { accountKey: string; force: boolean }) => {
    if (command === "account_capable_agents") return Promise.resolve(estado.capable);
    if (command === "claude_live_usage") {
      estado.liveCalls.push({ accountKey: args!.accountKey, force: args!.force });
      return Promise.resolve({ available: true, session: { percent: 55, resets: null }, week: null, weekModels: [], fetchedAt: 4_000_000_000, cached: false, problem: null });
    }
    if (command === "list_agent_accounts") return Promise.resolve(estado.identities.filter((i) => !String(i.id).startsWith("system:")));
    if (command === "system_accounts") return Promise.resolve(estado.identities.filter((i) => String(i.id).startsWith("system:")));
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (n: string) => `pool:${n}` }));
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => Promise.resolve({
    agents: [{ agentId: "claude-code", label: "Claude Code", installed: true, models: [], accounts: estado.accounts.map((a) => ({ ...a, models: [] })) }],
  }),
  refreshRosterModels: () => Promise.reject(new Error("não usado")),
}));

// O diálogo de nova conta tem um terminal de login (PTY): aqui basta saber para qual agente abriu.
vi.mock("@/features/accounts/AddAccountDialog", () => ({
  AddAccountDialog: ({ agentId, onClose }: { agentId: string; onClose: () => void }) => {
    estado.dialogs.push(agentId);
    return <div data-testid="add-account-dialog" data-agent={agentId}><button type="button" onClick={onClose}>fechar</button></div>;
  },
}));

import { AgentModelPicker, type AgentModelValue } from "../AgentModelPicker";
import { useAccountsStore } from "@/features/accounts/store";
import { useUsageStore } from "@/features/canvas/usageStore";

const SYSTEM = { accountId: null, name: "Claude Code", label: null, loggedIn: true };
const TRABALHO = { accountId: "a1", name: "trabalho", label: null, loggedIn: true };
const AGENTS = [{ id: "claude-code", label: "Claude Code", command: "claude", available: true } as never];
const identidade = (id: string, extra: Record<string, unknown>) => ({
  id, agentId: "claude-code", name: "x", dir: "/d", envVar: "X", loginCommand: "x", loggedIn: true, label: null, createdAt: 0,
  kind: "login", baseUrl: null, keyHint: null, displayName: null, accentColor: null, ...extra,
});

let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn<(next: AgentModelValue) => void>();
const mount = (value: AgentModelValue, showAccount = true) => act(async () => {
  root.render(<AgentModelPicker agents={AGENTS} value={value} onChange={onChange} showAccount={showAccount} />);
});
const openPicker = () => act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click(); });
const tabs = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((t) => t.dataset.tabValue !== "fav");
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const defaultRow = () => document.body.querySelector<HTMLButtonElement>('[role="option"]')!;
const VALUE: AgentModelValue = { agentId: "claude-code", model: null, effort: null, account: null };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  estado.accounts = [SYSTEM];
  estado.identities = [];
  useAccountsStore.setState({ accounts: [], systemAccounts: [], loaded: false });
  estado.liveCalls = [];
  estado.dialogs = [];
  estado.capable = [{ agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true }];
  useUsageStore.setState({ claude: {}, codex: {}, antigravity: {}, busy: {} });
  onChange.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ""; });

describe("trilho do seletor com várias contas", () => {
  it("com uma conta só há um ícone por agente, sem selo", async () => {
    await mount(VALUE);
    await openPicker();
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["Claude Code"]);
    expect(document.body.querySelector('[role="tab"] [data-account-badge]')).toBeNull();
  });

  it("com duas contas há um ícone por conta, com o nome de exibição e a cor do token", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    estado.identities = [identidade("a1", { name: "trabalho", displayName: "Trabalho", accentColor: "orange" })];
    await mount(VALUE);
    await openPicker();
    // O percentual de limite, quando já chegou, vem depois do nome.
    expect(tabs().map((t) => t.getAttribute("aria-label")!.split(" · chat.picker.accountLimitUsed")[0])).toEqual(["Claude Code · accounts.principalName", "Claude Code · Trabalho"]);
    const selo = tabs()[1].querySelector<HTMLElement>("[data-account-badge]")!;
    expect(selo.textContent).toBe("TR");
    expect(selo.style.backgroundColor).toContain("--color-orange-");
  });

  it("escolher o ícone de outra conta e um modelo muda agente e conta juntos", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    await mount(VALUE);
    await openPicker();
    await click(tabs()[1]);
    await click(defaultRow());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude-code", account: "a1" }));
  });

  it("o <select> de conta acompanha o ícone escolhido", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    await mount(VALUE);
    await openPicker();
    await click(tabs()[1]);
    const select = document.body.querySelector<HTMLSelectElement>("select[aria-label='chat.picker.account']")!;
    expect(select.value).toBe("a1");
  });

  it("o visto só aparece na conta em uso", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    await mount({ ...VALUE, account: "a1" });
    await openPicker();
    // Abre já no ícone da conta em uso.
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(defaultRow().getAttribute("aria-selected")).toBe("true");
    await click(tabs()[0]);
    expect(defaultRow().getAttribute("aria-selected")).toBe("false");
  });

  it("numa conversa aberta (conta fixa) o trilho não oferece troca de conta", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    await mount({ ...VALUE, account: "a1" }, false);
    await openPicker();
    expect(tabs()).toHaveLength(1);
    await click(defaultRow());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ account: "a1" }));
  });

  it("um pool escolhido continua sendo um pool: nenhum ícone de conta fica marcado e o valor segue como pool:<nome>", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    await mount({ ...VALUE, account: "pool:time" });
    await openPicker();
    expect(tabs().every((t) => t.getAttribute("aria-selected") === "false")).toBe(true);
    // Mesmo assim um ícone fica na ordem de tabulação.
    expect(tabs().filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(defaultRow().getAttribute("aria-selected")).toBe("true");
    await click(defaultRow());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ account: "pool:time" }));
  });

  const leitura = (session: number) => ({ available: true, session: { percent: session, resets: null }, week: null, weekModels: [], fetchedAt: 4_000_000_000, cached: false, problem: null });

  it("mostra a barra curta de limite de cada conta e o percentual no nome acessível", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    useUsageStore.setState({ claude: { "system:claude-code": leitura(12), a1: leitura(88) } });
    await mount(VALUE);
    await openPicker();
    const barras = [...document.body.querySelectorAll<HTMLElement>("[data-limit-bar]")];
    expect(barras.map((b) => b.dataset.limitBar)).toEqual(["12", "88"]);
    expect(barras[1].firstElementChild!.getAttribute("style")).toContain("width: 88%");
    expect(tabs()[1].getAttribute("aria-label")).toContain("chat.picker.accountLimitUsed");
  });

  it("com uma conta só não há barra nem consulta de cota", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": leitura(12) } });
    await mount(VALUE);
    await openPicker();
    expect(document.body.querySelector("[data-limit-bar]")).toBeNull();
    expect(estado.liveCalls).toEqual([]);
  });

  it("pede (sem forçar) a cota das contas que ainda não têm leitura, uma vez cada", async () => {
    estado.accounts = [SYSTEM, TRABALHO];
    estado.identities = [identidade("system:claude-code", { name: "Claude Code" }), identidade("a1", { name: "trabalho" })];
    await mount(VALUE);
    await openPicker();
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    expect(estado.liveCalls.map((c) => c.force)).toEqual([false, false]);
    expect(estado.liveCalls.map((c) => c.accountKey).sort()).toEqual(["a1", "system:claude-code"]);
    // Com leitura guardada, abrir de novo não consulta.
    estado.liveCalls = [];
    await openPicker();
    await openPicker();
    expect(estado.liveCalls).toEqual([]);
  });

  const botaoAdicionar = () => document.body.querySelector<HTMLButtonElement>("button[aria-label='chat.picker.addAccount']");
  const dialogo = () => document.body.querySelector<HTMLElement>("[data-testid='add-account-dialog']");

  it("o botão de nova conta abre o diálogo já com o agente da aba e fecha o seletor", async () => {
    await mount(VALUE);
    await openPicker();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); // a lista de agentes com conta chega
    await click(botaoAdicionar()!);
    expect(dialogo()?.dataset.agent).toBe("claude-code");
    expect(document.body.querySelector("[role='dialog'][aria-label='chat.picker.title']")).toBeNull();
    // Fechar o diálogo o desmonta.
    await click(dialogo()!.querySelector("button")!);
    expect(dialogo()).toBeNull();
  });

  it("não oferece nova conta numa conversa aberta nem para agente sem suporte a várias contas", async () => {
    await mount(VALUE, false);
    await openPicker();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(botaoAdicionar()).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    estado.capable = [];
    useAccountsStore.setState({ loaded: false, capable: [] });
    await mount(VALUE);
    await openPicker();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(botaoAdicionar()).toBeNull();
  });
});
