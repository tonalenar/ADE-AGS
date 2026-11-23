// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pools: [] as { id: string; name: string; agentId: string; members: (string | null)[]; strategy: "least_used" | "round_robin" | "sticky"; failover: boolean; paused?: boolean }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "pool_list_all") return Promise.resolve(state.pools);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o && "name" in o ? `${key}:${o.name}` : key),
    i18n: { language: "pt-BR" },
  }),
}));
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => Promise.resolve({
    agents: [
      {
        agentId: "claude-code",
        label: "Claude Code",
        installed: true,
        models: [],
        accounts: [
          { accountId: null, name: "Claude Code", label: null, loggedIn: true, models: [] },
          { accountId: "acc-1", name: "Trabalho", label: "work@exemplo.com", loggedIn: true, models: [] },
        ],
      },
    ],
  }),
  refreshRosterModels: () => Promise.reject(new Error("não usado")),
}));

import { usePoolsStore } from "@/features/accounts/pools";
import { useAccountsStore } from "@/features/accounts/store";
import { AgentModelPicker } from "@/features/chat/AgentModelPicker";
import { AccountPickerStep } from "@/features/tabs/wizard/AccountPickerStep";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.pools = [
    { id: "p-ok", name: "Ativo", agentId: "claude-code", members: [null, "acc-1"], strategy: "least_used", failover: true },
    { id: "p-main-and-ghost", name: "PrincipalEGhost", agentId: "claude-code", members: [null, "acc-apagada"], strategy: "sticky", failover: true },
    { id: "p-zero", name: "Vazio", agentId: "claude-code", members: [], strategy: "sticky", failover: true },
    { id: "p-orphan", name: "Orfao", agentId: "claude-code", members: ["acc-apagada-1", "acc-apagada-2"], strategy: "sticky", failover: true },
  ];
  usePoolsStore.setState({ pools: state.pools, loaded: true });
  useAccountsStore.setState({
    accounts: [
      { id: "acc-1", agentId: "claude-code", name: "Trabalho", dir: "/tmp/a", envVar: "CLAUDE_CONFIG_DIR", loginCommand: "claude", loggedIn: true, label: "work@exemplo.com", createdAt: 1, kind: "login", baseUrl: null, keyHint: null },
    ],
    systemAccounts: [],
    capable: [],
    loaded: true,
    health: {},
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("seletores de conta/pool com pool vazio", () => {
  it("AccountPickerStep (missões, squads, nova aba, frota) desabilita pool vazio com o motivo", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<AccountPickerStep agentId="claude-code" value={undefined} onChange={onChange} allowAuto />);
    });

    const buttons = [...host.querySelectorAll("button")];
    const okBtn = buttons.find((b) => b.textContent?.includes("Ativo"));
    const mainGhostBtn = buttons.find((b) => b.textContent?.includes("PrincipalEGhost"));
    const emptyBtn = buttons.find((b) => b.textContent?.includes("Vazio"));
    const orphanBtn = buttons.find((b) => b.textContent?.includes("Orfao"));

    expect(okBtn).toBeTruthy();
    expect(okBtn?.disabled).toBe(false);
    expect(mainGhostBtn).toBeTruthy();
    expect(mainGhostBtn?.disabled).toBe(false);
    expect(emptyBtn).toBeTruthy();
    expect(emptyBtn?.disabled).toBe(true);
    expect(emptyBtn?.textContent).toContain("accounts.pools.emptyOptionReason");
    expect(orphanBtn).toBeTruthy();
    expect(orphanBtn?.disabled).toBe(true);
    expect(orphanBtn?.textContent).toContain("accounts.pools.emptyOptionReason");

    await act(async () => { emptyBtn?.click(); orphanBtn?.click(); });
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => { okBtn?.click(); });
    expect(onChange).toHaveBeenCalledWith("pool:Ativo");
  });

  it("AgentModelPicker (chat) mostra pool vazio e órfão desabilitados com motivo no seletor de contas", async () => {
    const agents = [{ id: "claude-code", label: "Claude Code", command: "claude", available: true } as never];
    await act(async () => {
      root.render(
        <AgentModelPicker
          agents={agents}
          value={{ agentId: "claude-code", model: null, effort: null, account: null }}
          onChange={() => undefined}
        />,
      );
    });
    await act(async () => {
      (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click();
    });

    const options = [...document.body.querySelectorAll("select[aria-label='chat.picker.account'] option")] as HTMLOptionElement[];
    const okOpt = options.find((o) => o.value === "pool:Ativo");
    const mainGhostOpt = options.find((o) => o.value === "pool:PrincipalEGhost");
    const emptyOpt = options.find((o) => o.value === "pool:Vazio");
    const orphanOpt = options.find((o) => o.value === "pool:Orfao");

    expect(okOpt).toBeTruthy();
    expect(okOpt?.disabled).toBe(false);
    expect(okOpt?.textContent).toBe("chat.picker.pool:Ativo");

    expect(mainGhostOpt).toBeTruthy();
    expect(mainGhostOpt?.disabled).toBe(false);
    expect(mainGhostOpt?.textContent).toBe("chat.picker.pool:PrincipalEGhost");

    expect(emptyOpt).toBeTruthy();
    expect(emptyOpt?.disabled).toBe(true);
    expect(emptyOpt?.textContent).toBe("chat.picker.poolEmpty:Vazio");

    expect(orphanOpt).toBeTruthy();
    expect(orphanOpt?.disabled).toBe(true);
    expect(orphanOpt?.textContent).toBe("chat.picker.poolEmpty:Orfao");
  });
});
