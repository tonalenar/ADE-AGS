// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ accounts: [] as unknown[], calls: [] as unknown[][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => { if (cmd === "chat_account_set") backend.calls.push([cmd, args]); return Promise.resolve([]); },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => Promise.resolve({ agents: [{ agentId: "claude-code", label: "Claude Code", accounts: backend.accounts }] }),
}));

import { ThreadAccountMenu } from "../structured/ThreadAccountMenu";

const NOW = Math.floor(Date.now() / 1000);
const acc = (accountId: string | null, name: string, over: Record<string, unknown> = {}) =>
  ({ accountId, key: String(accountId), name, label: null, loggedIn: true, quota: null, running: 0, models: [], modelDiscovery: "ok", ...over });

let root: Root;
let host: HTMLDivElement;
const mount = (props: Partial<{ accountId: string | null; disabled: boolean }> = {}) => act(async () => {
  root.render(<ThreadAccountMenu threadId="t1" agentId="claude-code" accountId={props.accountId ?? null} disabled={props.disabled} />);
});
const select = () => host.querySelector("select") as HTMLSelectElement | null;
const pick = (value: string) => act(async () => {
  const el = select()!;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  backend.calls = [];
  backend.accounts = [acc(null, "Claude Code"), acc("b", "Erist", { label: "eri@x.com", quota: { fiveHour: null, sevenDay: null, rejected: true, rejectedUntil: NOW + 3_600, overage: false, observedAt: 1 } })];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("o seletor de conta da conversa aberta", () => {
  it("lista as contas com o estado, e a esgotada leva o aviso", async () => {
    await mount();
    expect([...host.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "chat.account.option{\"name\":\"accounts.system\",\"state\":\"chat.account.state.ready\"}",
      "chat.account.option{\"name\":\"eri@x.com\",\"state\":\"chat.account.state.exhausted\"}",
    ]);
  });

  it("some quando o agente tem uma conta só", async () => {
    backend.accounts = [acc(null, "Claude Code")];
    await mount();
    expect(select()).toBeNull();
  });

  it("escolher outra conta pede confirmação curta e só então troca", async () => {
    await mount();
    await pick("b");
    expect(backend.calls).toEqual([]);
    expect(host.textContent).toContain("chat.account.confirm");
    await act(async () => { button("chat.account.confirmYes")!.click(); });
    expect(backend.calls).toEqual([["chat_account_set", { threadId: "t1", accountId: "b" }]]);
  });

  it("cancelar não troca", async () => {
    await mount();
    await pick("b");
    await act(async () => { button("chat.account.confirmNo")!.click(); });
    expect(backend.calls).toEqual([]);
  });

  it("fica travado com o turno em andamento", async () => {
    await mount({ disabled: true });
    expect(select()!.disabled).toBe(true);
  });
});
