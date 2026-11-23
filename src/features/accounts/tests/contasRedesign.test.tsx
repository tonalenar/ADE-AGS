/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
// Toasts do sweetalert2 deixam timers que disparam depois do teardown do ambiente (`window is not defined`).
vi.mock("sweetalert2", () => ({ default: { fire: () => Promise.resolve({ isConfirmed: false }) } }));
const i18nResult = {
  t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k),
  i18n: { language: "pt-BR" },
};
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { useAccountsStore } from "@/features/accounts/store";
import type { AccountCapableAgent, AgentAccount } from "@/features/accounts/types";
import { usePoolsStore, type Pool } from "@/features/accounts/pools";
import { useAgentsStore } from "@/features/agents/store";
import { useLocalAcpStore } from "@/features/agents/localAcpStore";
import { useForgeStore } from "@/features/forge/store";
import { useProvidersStore } from "@/features/providers/store";
import { SettingsPageBody } from "@/features/settings/SettingsPages";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";
import { useTabsStore } from "@/features/tabs/store";

const SYS_AGY: AgentAccount = {
  id: "system:antigravity", agentId: "antigravity", name: "Antigravity", dir: "/Users/teste", envVar: "HOME",
  loginCommand: "agy", loggedIn: true, label: "Google AI Pro", createdAt: 0, kind: "login", baseUrl: null, keyHint: null,
};
const AGY_2: AgentAccount = {
  id: "a2", agentId: "antigravity", name: "Alencaar4", dir: "/data/accounts/antigravity/Alencaar4", envVar: "HOME",
  loginCommand: "agy", loggedIn: true, label: "alencaar4@exemplo.com", createdAt: 1, kind: "login", baseUrl: null, keyHint: null,
};
const AGY_EXPIRED: AgentAccount = {
  id: "a3", agentId: "antigravity", name: "Kiro0", dir: "/data/accounts/antigravity/Kiro0", envVar: "HOME",
  loginCommand: "agy", loggedIn: false, label: null, createdAt: 2, kind: "login", baseUrl: null, keyHint: null,
};
const SYS_CLAUDE: AgentAccount = {
  id: "system:claude-code", agentId: "claude-code", name: "Claude Code", dir: "/h/.claude", envVar: "CLAUDE_CONFIG_DIR",
  loginCommand: "claude", loggedIn: true, label: "ana@exemplo.com", createdAt: 0, kind: "login", baseUrl: null, keyHint: null,
};
const CAPABLE: AccountCapableAgent[] = [
  { agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true },
  { agentId: "antigravity", label: "Antigravity", envVar: "HOME", installed: true },
];
const POOL_DIARIO: Pool = {
  id: "p1", name: "Diário", agentId: "antigravity", members: [null, "a2"], strategy: "least_used", failover: true, paused: false,
};

let host: HTMLDivElement;
let root: Root;
let saved: Record<string, string>;
let currentPools: Pool[];

beforeEach(() => {
  saved = {};
  currentPools = [{ ...POOL_DIARIO }];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_agent_accounts") return [AGY_2, AGY_EXPIRED];
    if (cmd === "system_accounts") return [SYS_CLAUDE, SYS_AGY];
    if (cmd === "account_capable_agents") return CAPABLE;
    if (cmd === "forge_accounts") return [{ id: "g1", kind: "github", host: "github.com", login: "tonalenar", name: "Ton", auth: "token", storage: "keyring" }];
    if (cmd === "forge_kinds") return [];
    if (cmd === "pool_list_all") return currentPools;
    if (cmd === "pool_preview_picks") return [{ poolId: "p1", accountId: "a2", available: true, swapsToday: 2 }];
    if (cmd === "pool_update") {
      const next: Pool = {
        ...currentPools[0]!,
        id: String(args!.id),
        name: String(args!.name),
        members: args!.members as (string | null)[],
        strategy: args!.strategy as Pool["strategy"],
      };
      currentPools = [next];
      return next;
    }
    if (cmd === "antigravity_cli_usage") {
      return {
        installed: true,
        fetchedAt: 1_700_000_000,
        cached: false,
        groups: [
          { name: "Gemini", windows: [{ id: "s", kind: "session", usedPct: 4 }, { id: "w", kind: "weekly", usedPct: 27 }] },
          { name: "Claude e GPT", windows: [{ id: "s", kind: "session", usedPct: 0 }, { id: "w", kind: "weekly", usedPct: 62 }] },
          { name: "Gemini 4 Argon", windows: [{ id: "w", kind: "weekly", usedPct: 8 }] },
        ],
      };
    }
    if (cmd === "claude_live_usage") {
      return { available: true, session: { percent: 10, resets: "12:59" }, week: { percent: 25, resets: "qui" }, weekModels: [], fetchedAt: 1_700_000_000, cached: false, problem: null };
    }
    if (cmd === "agent_account_usage") return { plan: { tier: "max" } };
    if (cmd === "account_health") return { status: "ok", detail: "ok", email: "alencaar4@exemplo.com", plan: "Pro", checkedAt: 1 };
    if (cmd === "account_limits_get") return { maxConcurrent: 2, dailyBudgetUsd: 10 };
    if (cmd === "db_get_setting") return saved[String(args!.key)] ?? null;
    if (cmd === "db_set_setting") { saved[String(args!.key)] = String(args!.value); return undefined; }
    if (cmd === "agent_install_offers" || cmd === "agent_updates_check" || cmd === "local_acp_list") return [];
    if (cmd === "agent_search_path") return null;
    return undefined;
  });

  useAccountsStore.setState({ accounts: [AGY_2, AGY_EXPIRED], systemAccounts: [SYS_CLAUDE, SYS_AGY], capable: CAPABLE, loaded: true, health: {} });
  usePoolsStore.setState({ pools: currentPools, loaded: true });
  useForgeStore.setState({ accounts: [{ id: "g1", kind: "github", host: "github.com", login: "tonalenar", name: "Ton", auth: "token", storage: "keyring" } as never], kinds: [] });
  useProvidersStore.setState({ disabled: [], loaded: true });
  useAgentsStore.setState({ customAgents: [{ id: "c1", label: "aider", command: "aider --model sonnet", resumeArgs: "--resume {session}", sessionIdFrom: "filename" } as never] });
  useLocalAcpStore.setState({ providers: [], loaded: true });
  useSettingsTargetStore.setState({ target: null });
  useTabsStore.setState({
    detectedAgents: [
      { id: "claude-code", label: "Claude Code", command: "claude", available: true, version: "2.4.1", path: "/bin/claude" },
      { id: "antigravity", label: "Antigravity", command: "agy", available: true, version: "1.12.3", path: "/bin/agy" },
    ],
  });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async () => { await act(async () => { root.render(<SettingsPageBody page="accounts" />); }); };
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
const tabs = () => [...host.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];

describe("Redesenho de Configurações → Provedores e contas", () => {
  it("renderiza as 4 abas novas (Agentes | Contas | Pools | Personalizados) e troca entre elas", async () => {
    await mount();
    const topTabs = tabs().slice(0, 4).map((b) => b.textContent);
    expect(topTabs).toEqual([
      "providers.tab.agents",
      "settings.accounts",
      "providers.tab.pools",
      "providers.tab.custom",
    ]);

    // Personalizados não deixa o formulário aberto por padrão e abre diálogo pelo "+ Adicionar ▾".
    await click(tabs()[3]);
    expect(host.textContent).toContain("aider");
    expect(host.textContent).not.toContain("settings.tuis.addSection");
    const addBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.custom.addMenu"));
    await click(addBtn);
    expect(host.querySelectorAll('[role="menuitem"]').length).toBe(2);
  });

  it("sem cota guardada, abrir Contas do Antigravity busca a cota sozinho (sem precisar de Atualizar consumo)", async () => {
    const base = invokeMock.getMockImplementation()!;
    const forces: unknown[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "antigravity_cli_usage") {
        forces.push(args?.force);
        // O cache começa vazio: só a leitura forçada traz os grupos.
        if (!args?.force) return { installed: true, fetchedAt: 0, cached: false, groups: [] };
      }
      return base(cmd, args);
    });
    await mount();
    await click(host.querySelector('button[aria-label*="Antigravity"]'));
    const link = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.detail.manageInAccounts"));
    await click(link);
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain("Gemini 4 Argon");
    expect(forces).toContain(false);
    expect(forces).toContain(true);
  });

  it("o link Gerenciar em Contas no detalhe do agente troca para a aba Contas já no provedor certo", async () => {
    await mount();
    await click(host.querySelector('button[aria-label*="Antigravity"]'));
    const link = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.detail.manageInAccounts"));
    await click(link);

    // Aba Contas ativa e provedor Antigravity selecionado com a tabela de grupos de modelos e o botão Entrar só na conta expirada.
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("Gemini 4 Argon");
    expect(host.textContent).toContain("Alencaar4");
    expect(host.textContent).toContain("Kiro0");
    const signInButtons = [...host.querySelectorAll("button")].filter((b) => b.textContent === "providers.account.signIn");
    expect(signInButtons).toHaveLength(1);
    // Sem seção duplicada nem Notificações do sistema em Contas.
    expect(host.textContent).not.toContain("settings.notifications.label");
  });

  it("o menu ⋯ de uma conta exibe todas as ações e permite Tornar principal e Verificar conexão", async () => {
    await mount();
    await click(tabs()[1]); // Contas
    const agyTab = [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes("Antigravity"));
    await click(agyTab);

    const cardA2 = host.querySelector('[data-account-card="a2"]')!;
    const menuBtn = cardA2.querySelector('button[aria-haspopup="menu"]');
    await click(menuBtn);

    const items = [...cardA2.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent ?? "");
    expect(items.some((s) => s.includes("settings.accounts.menu.verify"))).toBe(true);
    expect(items.some((s) => s.includes("settings.accounts.relogin"))).toBe(true);
    expect(items.some((s) => s.includes("settings.accounts.menu.nameColor"))).toBe(true);
    expect(items.some((s) => s.includes("settings.accounts.menu.limits"))).toBe(true);
    expect(items.some((s) => s.includes("settings.accounts.menu.makePrimary"))).toBe(true);
    expect(items.some((s) => s.includes("settings.accounts.menu.copyPath"))).toBe(true);
    expect(items.some((s) => s.includes("settings.accounts.menu.remove"))).toBe(true);

    const makePrimary = [...cardA2.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes("settings.accounts.menu.makePrimary"));
    await click(makePrimary);
    expect(saved["accounts.primary.antigravity"]).toBe("a2");
  });

  it("a aba Pools mostra modo global, Agora escolheria X do backend e permite editar pool preservando pool.id", async () => {
    await mount();
    await click(tabs()[2]); // Pools

    expect(host.textContent).toContain("accounts.pools.mode.title");
    expect(host.textContent).toContain("accounts.pools.wouldPickPrefix");
    expect(host.textContent).toContain("Alencaar4");

    // Abrir menu ⋯ do pool Diário e clicar em Editar.
    const row = host.querySelector('[data-pool-row="p1"]')!;
    await click(row.querySelector('button[aria-haspopup="menu"]'));
    const editBtn = [...row.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes("btn.edit"));
    await click(editBtn);

    // Trocar estratégia para sticky e salvar.
    const stickyRadio = [...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes("accounts.pools.strategy.sticky.full"));
    await click(stickyRadio);
    const saveBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "btn.save");
    await click(saveBtn);

    expect(invokeMock).toHaveBeenCalledWith("pool_update", {
      id: "p1",
      name: "Diário",
      members: [null, "a2"],
      strategy: "sticky",
    });
  });

  it("ao remover uma conta que está em um pool, o diálogo avisa quais pools a usam", async () => {
    await mount();
    await click(tabs()[1]); // Contas
    const agyTab = [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes("Antigravity"));
    await click(agyTab ?? null);

    const cardA2 = host.querySelector('[data-account-card="a2"]')!;
    await click(cardA2.querySelector('button[aria-haspopup="menu"]'));
    const removeBtn = [...cardA2.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes("settings.accounts.menu.remove"));
    await click(removeBtn);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('settings.accounts.delete.inPools {"pools":"Diário"}');
  });

  it("ao remover a última conta de um pool, o diálogo avisa que esse pool ficará vazio", async () => {
    currentPools = [
      { id: "p1", name: "Diário", agentId: "antigravity", members: [null, "a2"], strategy: "least_used", failover: true, paused: false },
      { id: "p2", name: "SóA2", agentId: "antigravity", members: ["a2"], strategy: "sticky", failover: true, paused: false },
    ];
    usePoolsStore.setState({ pools: currentPools, loaded: true });

    await mount();
    await click(tabs()[1]); // Contas
    const agyTab = [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes("Antigravity"));
    await click(agyTab ?? null);

    const cardA2 = host.querySelector('[data-account-card="a2"]')!;
    await click(cardA2.querySelector('button[aria-haspopup="menu"]'));
    const removeBtn = [...cardA2.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes("settings.accounts.menu.remove"));
    await click(removeBtn);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('settings.accounts.delete.inPools {"pools":"Diário"}');
    expect(alert?.textContent).toContain('settings.accounts.delete.emptiesPools {"count":1,"pools":"SóA2"}');
  });

  it("na aba Pools, um pool vazio exibe estado claro com ações Editar e Excluir", async () => {
    currentPools = [
      { id: "p-empty", name: "Vazio", agentId: "antigravity", members: [], strategy: "sticky", failover: false, paused: true },
    ];
    usePoolsStore.setState({ pools: currentPools, loaded: true });

    await mount();
    await click(tabs()[2]); // Pools

    const row = host.querySelector('[data-pool-row="p-empty"]')!;
    expect(row.textContent).toContain("accounts.pools.emptyState");
    expect(row.textContent).toContain("accounts.pools.emptyStateHint");
    expect(row.textContent).not.toContain("accounts.pools.pausedLine");

    const editBtn = [...row.querySelectorAll("button")].find((b) => b.textContent === "btn.edit");
    const deleteBtn = [...row.querySelectorAll("button")].find((b) => b.textContent === "btn.delete");
    expect(editBtn).toBeTruthy();
    expect(deleteBtn).toBeTruthy();

    await click(editBtn);
    expect(document.body.textContent).toContain("accounts.pools.editTitle");

    const cancelBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "btn.cancel");
    await click(cancelBtn);

    await click(deleteBtn);
    expect(document.body.textContent).toContain('accounts.pools.deleteDialog.title {"name":"Vazio"}');
  });
});
