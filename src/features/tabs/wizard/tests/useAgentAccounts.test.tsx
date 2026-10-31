// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ accounts: [] as { id: string; agentId: string; name: string }[], loads: 0 }));
vi.mock("@/features/accounts/ipc", () => ({
  listAccounts: () => { disk.loads++; return Promise.resolve(disk.accounts); },
  listCapableAgents: () => Promise.resolve([]),
  listSystemAccounts: () => Promise.resolve([]),
}));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (n: string) => `pool:${n}`, isPoolValue: () => false, poolNameOf: (v: string) => v }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { useAgentAccounts } from "../AccountPickerStep";

let root: Root;
let host: HTMLDivElement;
let seen: AgentAccount[] = [];
function Probe({ open }: { open: boolean }) {
  seen = useAgentAccounts("claude-code", open);
  return null;
}
const render = (open: boolean) => act(async () => { root.render(<Probe open={open} />); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  disk.accounts = []; disk.loads = 0; seen = [];
  useAccountsStore.setState({ accounts: [], systemAccounts: [], capable: [], loaded: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("as contas do assistente de novo agente", () => {
  it("uma conta criada fora da janela (CLI, outra janela) aparece quando o diálogo abre de novo", async () => {
    await render(true); // primeira abertura: só a principal
    expect(seen).toEqual([]);
    await render(false); // fecha
    disk.accounts = [{ id: "ton", agentId: "claude-code", name: "Ton" }];
    await render(true); // abre de novo
    expect(seen.map((a) => a.name)).toEqual(["Ton"]);
  });

  it("enquanto o diálogo está fechado, não relê o disco à toa", async () => {
    await render(false);
    const loads = disk.loads;
    await render(false);
    expect(disk.loads).toBe(loads);
  });
});
