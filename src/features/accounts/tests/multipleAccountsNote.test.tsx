/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MultipleAccountsNote } from "@/features/accounts/MultipleAccountsNote";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const principal = (agentId: string, loggedIn = true): AgentAccount => ({
  id: `system:${agentId}`, agentId, name: agentId, dir: "/d", envVar: "X", loginCommand: "x", loggedIn, label: null,
  createdAt: 0, kind: "login", baseUrl: null, keyHint: null,
});

let host: HTMLDivElement;
let root: Root;
const render = (agentId: string) => act(async () => {
  root.render(<MultipleAccountsNote agentId={agentId} agentLabel="Claude Code" />);
});

beforeEach(() => {
  useAccountsStore.setState({ accounts: [], systemAccounts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("aviso ao adicionar a 2ª conta", () => {
  it("aparece como nota quando o agente já tem uma conta com login", async () => {
    useAccountsStore.setState({ systemAccounts: [principal("claude-code")] });
    await render("claude-code");
    const nota = host.querySelector('[role="note"]');
    expect(nota?.textContent).toBe("accounts.multipleNote");
  });

  it("não aparece na primeira conta nem em agente sem o aviso", async () => {
    await render("claude-code");
    expect(host.textContent).toBe("");
    useAccountsStore.setState({ systemAccounts: [principal("opencode")] });
    await render("opencode");
    expect(host.textContent).toBe("");
  });
});
