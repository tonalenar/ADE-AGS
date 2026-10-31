// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ teams: [] as unknown[], summary: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "chat_team_list" ? backend.teams : []),
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
import type { TeamView } from "../team/ipc";
import { useTeamStore } from "../team/teamStore";
import { LimitsCard } from "../summary/LimitsCard";

const NOW = Math.floor(Date.now() / 1000);
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
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const text = () => host.textContent ?? "";
const bars = () => [...host.querySelectorAll("[role=progressbar]")] as HTMLElement[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  backend.teams = []; backend.summary = [];
  refreshes = [];
  useAccountsStore.setState({ accounts: [TON], systemAccounts: [SYS_CLAUDE, SYS_CODEX], capable: [], loaded: true });
  useUsageStore.setState({ claude: {}, codex: {}, antigravity: {}, busy: {} });
  useUsageStore.setState({ refresh: (a: AgentAccount, force: boolean) => { refreshes.push([a.id, force]); return Promise.resolve(); } } as never);
  useTabsStore.setState({ tabs: [tab()] } as never);
  useStructured.setState({ threads: [], live: {}, hydrated: {} });
  useChatLive.setState({ phase: {} });
  useTeamStore.setState({ teams: [], feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("o cartão Limites de uso", () => {
  it("mostra a janela atual e a semanal da conta em uso (a principal, sem conta escolhida)", async () => {
    useUsageStore.setState({ claude: { "system:claude-code": live(42, 17) } });
    await mount();
    expect(text()).toContain("chat.summary.limits.title");
    expect(text()).toContain('chat.summary.limits.account{"account":"accounts.system"}');
    expect(bars().map((b) => b.getAttribute("aria-valuenow"))).toEqual(["42", "17"]);
    expect(text()).toContain("chat.accounts.window");
    expect(text()).toContain("chat.accounts.week");
    expect(text()).toContain('chat.summary.limits.renewsText{"when":"3pm"}');
  });

  it("usa a conta escolhida na conversa, não a principal", async () => {
    useTabsStore.setState({ tabs: [tab("ton")] } as never);
    useUsageStore.setState({ claude: { "system:claude-code": live(10, 10), ton: live(55, 20) } });
    await mount();
    expect(text()).toContain('"account":"Ton"');
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
    expect(refreshes).toEqual([["system:claude-code", false]]);
  });

  it("pede de novo quando o turno termina, e só então", async () => {
    await mount();
    expect(refreshes).toHaveLength(1);
    await act(async () => { useChatLive.setState({ phase: { "tab-1": "working" } }); });
    expect(refreshes).toHaveLength(1);
    await act(async () => { useChatLive.setState({ phase: { "tab-1": "idle" } }); });
    expect(refreshes).toHaveLength(2);
    await act(async () => { useChatLive.setState({ phase: { "tab-1": "idle" } }); });
    expect(refreshes).toHaveLength(2);
  });
});

describe("conversa com time", () => {
  const TEAM = {
    id: "t1", orchestrator: "tab-1", agentId: "claude-code", label: "Claude Code", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 4,
    members: [
      { teamId: "t1", member: "tab-2", agentId: "codex", label: "Codex · Revisor", role: "reviewer", model: null, policy: "read", branch: null, worktree: null, origin: "new", position: 0, createdAt: 1, updatedAt: 1, subagent: false },
      { teamId: "t1", member: "tab-3", agentId: "claude-code", label: "Claude · Testes", role: "qa", model: null, policy: "ask", branch: null, worktree: null, origin: "new", position: 1, createdAt: 1, updatedAt: 1, subagent: false },
      { teamId: "t1", member: "tab-4", agentId: "claude-code", label: "Claude · UI", role: "frontend", model: null, policy: "ask", branch: null, worktree: null, origin: "new", position: 2, createdAt: 1, updatedAt: 1, subagent: false },
    ],
  } as unknown as TeamView;

  beforeEach(() => {
    backend.teams = [TEAM];
    useTeamStore.setState({ teams: [TEAM] });
    useTabsStore.setState({ tabs: [tab(), { ...tab(undefined, "codex"), id: "tab-2" }, { ...tab("ton"), id: "tab-3" }, { ...tab(), id: "tab-4" }] } as never);
    useUsageStore.setState({
      claude: { "system:claude-code": live(42, 17), ton: live(91, 30) },
      codex: { "system:codex": { usage: { email: null, plan: null, auth: "chatgpt", fetchedAt: NOW, quota: { fiveHour: { utilization: 0.2, resetsAt: NOW + 600 }, sevenDay: null, rejected: false, rejectedUntil: null, overage: false } }, failed: false } },
    });
  });

  it("as contas dos integrantes ficam recolhidas por padrão e a conta repetida não aparece de novo", async () => {
    await mount();
    const toggle = [...host.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent?.includes("teamShow"))!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain('"count":2');
    expect(bars()).toHaveLength(2); // só as janelas da conta da própria conversa
  });

  it("aberto, traz uma linha por conta distinta: quem · conta · % da janela", async () => {
    await mount();
    await click([...host.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent?.includes("teamShow")));
    expect(text()).toContain("Codex · Revisor · accounts.system");
    expect(text()).toContain("20%");
    expect(text()).toContain("Claude · Testes · Ton");
    expect(text()).toContain("91%");
    expect(text()).toContain("chat.summary.limits.nearLimit");
    expect(text()).not.toContain("Claude · UI");
  });
});
