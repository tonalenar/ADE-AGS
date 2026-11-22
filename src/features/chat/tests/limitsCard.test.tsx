// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ teams: [] as unknown[], summary: [] as unknown[], pools: [] as unknown[], poolState: { poolName: null, originLabel: null } as unknown }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "chat_team_list" ? backend.teams : cmd === "chat_pool_state" ? backend.poolState : cmd === "pool_list_all" ? backend.pools : []),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/features/accounts/ipc", () => ({
  accountUsageSummary: () => Promise.resolve(backend.summary),
  listAccounts: () => Promise.resolve([]),
  listSystemAccounts: () => Promise.resolve([]),
  listCapableAgents: () => Promise.resolve([]),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { useUsageStore } from "@/features/canvas/usageStore";
import { useTabsStore } from "@/features/tabs/store";
import type { ConversationCard } from "../chatModel";
import { useChatLive } from "../liveStore";
import { useStructured } from "../structured/store";
import { useTeamStore } from "../team/teamStore";
import { LimitsCard } from "../summary/LimitsCard";

const NOW = 1_700_000_000;
const account = (id: string, agentId: string, name: string, over: Partial<AgentAccount> = {}): AgentAccount =>
  ({ id, agentId, name, dir: "", envVar: "", loginCommand: "", loggedIn: true, label: null, createdAt: 1, kind: "login", ...over }) as AgentAccount;
const SYS_CLAUDE = account("system:claude-code", "claude-code", "Claude Code");
const TON = account("ton", "claude-code", "Ton");
const SYS_CODEX = account("system:codex", "codex", "Codex");

const card = (agentId = "claude-code", label = "Claude Code"): ConversationCard => ({
  tabId: "tab-1", title: "Conversa", project: "repo", cwd: "/repo", branch: "main", isWorktree: false, agentId, agentLabel: label, starting: false, active: false, openedAt: 1,
});
const live = (session: number, week: number) => ({
  available: true, session: { percent: session, resets: "3pm" }, week: { percent: week, resets: "Mon 9am" }, weekModels: [], fetchedAt: NOW, cached: false, problem: null,
});
const tab = (accountId?: string, agentId = "claude-code") => ({ id: "tab-1", agentId, accountId, title: "t", cwd: "/repo" });

let root: Root;
let host: HTMLDivElement;
let refreshes: [string, boolean][] = [];
const mount = (c = card()) => act(async () => { root.render(<LimitsCard conversation={c} />); });
const text = () => host.textContent ?? "";
const bars = () => [...host.querySelectorAll("[role=progressbar]")] as HTMLElement[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  localStorage.clear();
  backend.teams = []; backend.summary = []; backend.pools = []; backend.poolState = { poolName: null, originLabel: null };
  refreshes = [];
  useAccountsStore.setState({ accounts: [TON], systemAccounts: [SYS_CLAUDE, SYS_CODEX], capable: [], loaded: true });
  useUsageStore.setState({ claude: {}, codex: {}, antigravity: {}, busy: {} });
  useUsageStore.setState({ refresh: (a: AgentAccount, force: boolean) => { refreshes.push([a.id, force]); return Promise.resolve(); }, refreshAgy: () => Promise.resolve(), agy: { usage: null, failed: false } } as never);
  useTabsStore.setState({ tabs: [tab()] } as never);
  useStructured.setState({ threads: [], live: {}, hydrated: {} });
  useChatLive.setState({ phase: {} });
  useTeamStore.setState({ teams: [], feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.useRealTimers(); });

describe("o cartão Limites de uso", () => {
  it("mostra a janela atual e a semanal da conta em uso (a principal, sem conta escolhida)", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": live(42, 17) } });
    await mount();
    expect(text()).toContain("chat.summary.limits.title");
    expect(text()).toContain("Claude Code");
    expect(text()).toContain("accounts.system");
    expect(bars().map((b) => b.getAttribute("aria-valuenow"))).toEqual(["42", "17"]);
    expect(text()).toContain("chat.accounts.window");
    expect(text()).toContain("chat.accounts.week");
    expect(text()).toContain('chat.summary.limits.renewsText{"when":"3pm"}');
  });

  it("usa a conta escolhida na conversa, não a principal", async () => {
    useTabsStore.setState({ tabs: [tab("ton")] } as never);
    useUsageStore.setState({ claude: { "system:claude-code": live(10, 10), ton: live(55, 20) } });
    await mount();
    expect(text()).toContain("Ton");
    expect(bars()[0]!.getAttribute("aria-valuenow")).toBe("55");
  });

  it("acima de 80% fica âmbar COM texto 'quase no limite'; em 100% fica vermelha com 'esgotado'", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": live(85, 100) } });
    await mount();
    const [session, week] = bars();
    expect(session!.querySelector("span")!.className).toContain("bg-amber-500");
    expect(week!.querySelector("span")!.className).toContain("bg-rose-500");
    expect(session!.getAttribute("aria-valuetext")).toContain("chat.summary.limits.nearLimit");
    expect(week!.getAttribute("aria-valuetext")).toContain("chat.summary.limits.exhausted");
    expect(text()).toContain("chat.summary.limits.nearLimit");
    expect(text()).toContain("chat.summary.limits.exhausted");
  });

  it("até 80% a barra é a normal, sem aviso", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": live(80, 10) } });
    await mount();
    expect(bars()[0]!.querySelector("span")!.className).toContain("bg-accent-500");
    expect(text()).not.toContain("nearLimit");
  });

  it("Codex mostra quanto falta para a janela renovar", async () => {
    useTabsStore.setState({ tabs: [tab(undefined, "codex")] } as never);
    useUsageStore.setState({ codex: { "system:codex": { usage: { email: null, plan: "plus", auth: "chatgpt", fetchedAt: NOW, quota: { fiveHour: { utilization: 0.3, resetsAt: NOW + 2 * 3600 + 14 * 60 }, sevenDay: { utilization: 0.5, resetsAt: NOW + 3 * 86400 }, rejected: false, rejectedUntil: null, overage: false } }, failed: false } } });
    await mount(card("codex", "Codex"));
    expect(text()).toContain('chat.summary.limits.renewsIn{"time":"2 h 14 min"}');
    expect(text()).toContain("chat.summary.limits.renewsAt");
  });

  it("agente sem cota exposta: 'não medido', o motivo e nenhuma barra", async () => {
    useTabsStore.setState({ tabs: [tab(undefined, "gemini")] } as never);
    await mount(card("gemini", "Gemini"));
    expect(text()).toContain("chat.summary.notMeasured");
    expect(text()).toContain("chat.summary.limits.reason.noSource");
    expect(bars()).toEqual([]);
  });

  it("falha na leitura: 'não medido' sem número inventado", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": { available: false, session: null, week: null, weekModels: [], fetchedAt: 0, cached: false, problem: "x" } } });
    await mount();
    expect(text()).toContain("chat.summary.limits.reason.failed");
    expect(bars()).toEqual([]);
    expect(text()).not.toMatch(/\d+%/);
  });

  it("conta sem login: 'não medido · conta sem login'", async () => {
    useAccountsStore.setState({ systemAccounts: [{ ...SYS_CLAUDE, loggedIn: false }, SYS_CODEX] });
    useUsageStore.setState({ claude: { "system:claude-code": live(42, 17) } });
    await mount();
    expect(text()).toContain("chat.summary.limits.reason.notLoggedIn");
    expect(bars()).toEqual([]);
  });

  it("mostra o gasto do dia só quando a conta tem teto configurado", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": live(10, 10) } });
    backend.summary = [{ accountKey: "system:claude-code", agentId: "claude-code", limits: { maxConcurrent: null, dailyBudgetUsd: 20 }, spent24h: 5 }];
    await mount();
    expect(text()).toContain('chat.summary.limits.budgetOf{"spent":"5.00","budget":"20.00"}');
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    backend.summary = [{ accountKey: "system:claude-code", agentId: "claude-code", limits: { maxConcurrent: null, dailyBudgetUsd: null }, spent24h: 5 }];
    await mount();
    expect(text()).not.toContain("budgetOf");
  });
});

describe("atualização: ao abrir e no fim de cada turno, sem polling", () => {
  it("pede a leitura (com a validade do store, sem forçar) ao abrir", async () => {
    await mount();
    // só a conta que a conversa usa é relida, com a validade do store (nada forçado); as outras mostram
    // o último snapshot local (Ton e Codex estão listadas, mas não são pedidas).
    expect(refreshes).toEqual([["system:claude-code", false]]);
  });

  it("uma mudança nas abas que não troca a conta em uso não relê a cota", async () => {
    await mount();
    const first = refreshes.length;
    await act(async () => { useTabsStore.setState({ tabs: [tab()] } as never); });
    expect(refreshes).toHaveLength(first);
  });

  it("pede de novo quando o turno termina, e só então", async () => {
    await mount();
    const first = refreshes.length;
    expect(first).toBe(1);
    await act(async () => { useChatLive.setState({ phase: { "tab-1": "working" } }); });
    expect(refreshes).toHaveLength(first);
    await act(async () => { useChatLive.setState({ phase: { "tab-1": "idle" } }); });
    expect(refreshes).toHaveLength(first * 2);
    await act(async () => { useChatLive.setState({ phase: { "tab-1": "idle" } }); });
    expect(refreshes).toHaveLength(first * 2);
  });
});

describe("todas as contas conectadas, não só as da conversa", () => {
  beforeEach(() => {
    useUsageStore.setState({
      claude: { "system:claude-code": live(42, 17), ton: live(100, 30) },
      codex: { "system:codex": { usage: { email: null, plan: null, auth: "chatgpt", fetchedAt: NOW, quota: { fiveHour: { utilization: 0.2, resetsAt: NOW + 600 }, sevenDay: { utilization: 0.9, resetsAt: NOW + 86400 }, rejected: false, rejectedUntil: null, overage: false } }, failed: false } },
    });
  });

  it("Outras contas vem recolhido por padrão com a quantidade e uma linha de aviso acima de 80%; aberto lista barrinha + % e expande detalhes", async () => {
    await mount();
    const collapsed = host.textContent ?? "";
    expect(collapsed).toContain('chat.summary.limits.others{"count":2}');
    // Recolhido por padrão: só as 2 barras da conta principal + aviso de 2 contas acima de 80%.
    expect(bars()).toHaveLength(2);
    expect(collapsed).toContain('chat.summary.limits.othersHighUsage{"count":2}');
    expect(collapsed).not.toContain("Ton");
    expect(collapsed).not.toContain("Codex");

    // Abrir "Outras contas": lista compacta com barrinha + % por conta (2 principais + 2 compactas = 4).
    const toggleOthers = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.summary.limits.others"))!;
    expect(toggleOthers.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { toggleOthers.click(); });
    expect(toggleOthers.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Ton");
    expect(host.textContent).toContain("Codex");
    expect(host.textContent).toContain("100%");
    expect(host.textContent).toContain("90%");
    expect(bars()).toHaveLength(4);

    // Clicar em "Ton" abre os detalhes dela (2 janelas extras -> 6 barras no total).
    const tonRow = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Ton"))!;
    await act(async () => { tonRow.click(); });
    expect(tonRow.getAttribute("aria-expanded")).toBe("true");
    expect(bars()).toHaveLength(6);
  });

  it("a conta esgotada nos detalhes fica vermelha e diz «esgotado» (não só a cor)", async () => {
    await mount();
    const toggleOthers = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.summary.limits.others"))!;
    await act(async () => { toggleOthers.click(); });
    const tonRow = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Ton"))!;
    await act(async () => { tonRow.click(); });
    const full = bars().find((b) => b.getAttribute("aria-valuenow") === "100" && b.getAttribute("aria-valuetext")?.includes("exhausted"))!;
    expect(full.querySelector("span")!.className).toContain("bg-rose-500");
    expect(full.getAttribute("aria-valuetext")).toContain("chat.summary.limits.exhausted");
  });

  it("«não medido» só para o agente que de fato não expõe a cota (e que a conversa usa)", async () => {
    useTabsStore.setState({ tabs: [tab(undefined, "gemini-cli")] } as never);
    await mount(card("gemini-cli", "Gemini"));
    expect(text()).toContain("chat.summary.limits.reason.noSource");
    // Abrir Outras contas mostra as demais contas medidas.
    const toggleOthers = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.summary.limits.others"))!;
    await act(async () => { toggleOthers.click(); });
    expect(bars().length).toBeGreaterThan(0);
  });

  it("o Cursor instalado aparece em Outras contas e nos detalhes diz «não medido · sem fonte de cota»", async () => {
    useTabsStore.setState({ tabs: [tab()], detectedAgents: [{ id: "cursor", label: "Cursor", command: "cursor-agent", available: true }] } as never);
    await mount();
    const toggleOthers = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.summary.limits.others"))!;
    await act(async () => { toggleOthers.click(); });
    expect(text()).toContain("Cursor");
    const cursorRow = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Cursor"))!;
    await act(async () => { cursorRow.click(); });
    expect(text()).toContain("chat.summary.limits.reason.noQuotaSource");
    // sem o Cursor instalado, ele não é listado
    useTabsStore.setState({ detectedAgents: [] } as never);
    await act(async () => { root.render(<LimitsCard conversation={card()} />); });
    expect(text()).not.toContain("chat.summary.limits.reason.noQuotaSource");
  });

  it("o Antigravity sem perfil (o login local do agy) mostra as janelas por grupo de modelos ao abrir detalhes", async () => {
    const iso = new Date((NOW + 3600) * 1000).toISOString();
    useUsageStore.setState({ agy: { usage: { installed: true, fetchedAt: NOW, cached: false, groups: [{ name: "Gemini", windows: [{ id: "a", kind: "session", usedPct: 33, resetsAt: iso }, { id: "b", kind: "weekly", usedPct: 12 }] }] }, failed: false } } as never);
    await mount();
    const toggleOthers = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.summary.limits.others"))!;
    await act(async () => { toggleOthers.click(); });
    const agyRow = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Antigravity"))!;
    await act(async () => { agyRow.click(); });
    const values = bars().map((b) => b.getAttribute("aria-valuenow"));
    expect(values).toContain("33");
    expect(values).toContain("12");
    expect(text()).toContain("Antigravity");
    expect(text()).toContain("Gemini · chat.accounts.window");
  });

  it("conta extra do Antigravity (perfil HOME isolado) lê e exibe seus próprios grupos de cota sem misturar com a principal", async () => {
    const kiro = account("kiro0", "antigravity", "Kiro0", { envVar: "HOME", dir: "/tmp/accounts/antigravity/Kiro0" });
    const sysAgy = account("system:antigravity", "antigravity", "Antigravity", { envVar: "HOME", dir: "/Users/teste" });
    const iso = new Date((NOW + 3600) * 1000).toISOString();
    useAccountsStore.setState({ accounts: [kiro], systemAccounts: [sysAgy], capable: [], loaded: true });
    useTabsStore.setState({ tabs: [tab("kiro0", "antigravity")] } as never);
    useUsageStore.setState({
      agy: {
        usage: {
          installed: true, fetchedAt: NOW, cached: false,
          groups: [{ name: "Gemini Models", windows: [{ id: "sys-w", kind: "weekly", usedPct: 24, resetsAt: iso }] }],
        },
        failed: false,
      },
      antigravity: {
        kiro0: {
          meters: null,
          groups: [
            { name: "Gemini Models", windows: [{ id: "k-w", kind: "weekly", usedPct: 61, resetsAt: iso }, { id: "k-s", kind: "session", usedPct: 15, resetsAt: iso }] },
            { name: "Claude and GPT models", windows: [{ id: "k-c", kind: "weekly", usedPct: 8, resetsAt: iso }] },
          ],
          failed: false,
          fetchedAt: NOW,
        },
      },
    } as never);
    await mount(card("antigravity", "Antigravity"));
    expect(refreshes).toEqual([["kiro0", false]]);
    expect(text()).toContain("Kiro0");
    expect(text()).not.toContain("chat.summary.limits.reason.failed");
    expect(text()).toContain("Gemini Models · chat.accounts.week");
    expect(text()).toContain("Gemini Models · chat.accounts.window");
    expect(text()).toContain("Claude and GPT models · chat.accounts.week");
    const values = bars().map((b) => b.getAttribute("aria-valuenow"));
    expect(values.slice(0, 3)).toEqual(["61", "15", "8"]);
  });

  describe("o pool da conversa", () => {
    const asThread = () => {
      useStructured.setState({ threads: [{ id: "t1", accountId: "ton" }], live: {}, hydrated: {} } as never);
      return card();
    };
    it("mostra o pool a que a conversa está ligada e a conta de origem depois da troca", async () => {
      useUsageStore.setState({ claude: { ton: live(10, 10) } });
      backend.poolState = { poolName: "Pool Teste", originLabel: "Ton" };
      await mount({ ...asThread(), tabId: "thread:t1" });
      expect(text()).toContain('chat.summary.limits.poolSwitched{"pool":"Pool Teste","origin":"Ton"}');
    });
    it("avisa que a conversa está fora de pool quando a conta dela é de um pool", async () => {
      useUsageStore.setState({ claude: { ton: live(10, 10) } });
      backend.pools = [{ id: "p1", name: "Pool Teste", agentId: "claude-code", members: [null, "ton"], strategy: "least_used", failover: false }];
      await mount({ ...asThread(), tabId: "thread:t1" });
      expect(text()).toContain('chat.summary.limits.poolAvailable{"pool":"Pool Teste"}');
    });
  });
});
