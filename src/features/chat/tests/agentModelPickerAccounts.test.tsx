// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roster = vi.hoisted(() => ({ calls: 0, accounts: [] as { accountId: string | null; name: string; label: string | null; loggedIn: boolean }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "name" in o ? `${key}:${o.name}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (n: string) => `pool:${n}` }));
// O backend monta o roster na hora com as contas que existem AGORA; a tela é que o guardava para sempre.
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => {
    roster.calls++;
    return Promise.resolve({ agents: [{ agentId: "claude-code", label: "Claude Code", installed: true, models: [], accounts: roster.accounts.map((a) => ({ ...a, models: [] })) }] });
  },
  refreshRosterModels: () => Promise.reject(new Error("não usado")),
}));

import { AgentModelPicker } from "../AgentModelPicker";

const SYSTEM = { accountId: null, name: "Claude Code", label: null, loggedIn: true };
const TON = { accountId: "f6af9857-5d33-4011-955f-0c9b75d4ca41", name: "Ton", label: null, loggedIn: true };
const AGENTS = [{ id: "claude-code", label: "Claude Code", command: "claude", available: true } as never];

let root: Root;
let host: HTMLDivElement;
const mount = () => act(async () => {
  root.render(<AgentModelPicker agents={AGENTS} value={{ agentId: "claude-code", model: null, effort: null, account: null }} onChange={() => undefined} />);
});
const openPicker = () => act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click(); });
const accountOptions = () => [...host.querySelectorAll("select[aria-label='chat.picker.account'] option")].map((o) => o.textContent);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  roster.calls = 0;
  roster.accounts = [SYSTEM];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("o seletor de conta do modelo", () => {
  it("lista as contas que existem quando o seletor abre", async () => {
    roster.accounts = [SYSTEM, TON];
    await mount();
    await openPicker();
    expect(accountOptions()).toEqual(["accounts.system", "Ton"]);
  });

  it("uma conta criada depois de o roster ser carregado aparece ao abrir (o roster não vale para sempre)", async () => {
    const MARIA = { accountId: "maria-id", name: "Maria", label: null, loggedIn: true };
    await mount(); // o roster já foi carregado (aqui ou por um seletor anterior) sem a Maria
    const before = roster.calls;
    roster.accounts = [SYSTEM, MARIA]; // a Maria nasce (pela tela, pela CLI ou por outra janela)
    await openPicker();
    expect(accountOptions()).toEqual(["accounts.system", "Maria"]);
    expect(roster.calls).toBeGreaterThan(before);
  });

  it("uma conta removida some ao abrir de novo", async () => {
    roster.accounts = [SYSTEM, TON];
    await mount();
    await openPicker();
    await act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click(); }); // fecha
    roster.accounts = [SYSTEM];
    await openPicker();
    expect(accountOptions()).toEqual(["accounts.system"]);
  });

  it("o rótulo da conta é o e-mail quando existe, senão o nome", async () => {
    roster.accounts = [SYSTEM, { ...TON, label: "ton@example.com" }];
    await mount();
    await openPicker();
    expect(accountOptions()).toEqual(["accounts.system", "ton@example.com"]);
  });
});
