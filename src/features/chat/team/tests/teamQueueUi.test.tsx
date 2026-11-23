// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: unknown }[] = [];
const queue = {
  maxAgents: 3,
  items: [
    { id: "q1", status: "pending", title: "Reescrever a timeline", waitingOn: ["esperando Ana terminar", "limite de 3 agentes simultâneos cheio (A, B, C)"], areas: ["src/features/chat/**"], createdAt: 1 },
    { id: "q2", status: "pending", title: "Docs", waitingOn: [], areas: [], createdAt: 2 },
  ],
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => {
    calls.push({ command, args });
    if (command === "chat_team_queue") return Promise.resolve(queue);
    if (command === "chat_team_queue_cancel") return Promise.resolve(true);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));

import { MaxAgentsSetting } from "../MaxAgentsSetting";
import { TeamQueuePanel } from "../TeamQueue";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a fila do time na tela", () => {
  it("mostra cada tarefa esperando com o motivo e pede a fila do orquestrador certo", async () => {
    await act(async () => { root.render(<TeamQueuePanel threadId="pai" />); });
    expect(calls[0]).toEqual({ command: "chat_team_queue", args: { parent: "thread:pai", all: false } });
    const text = host.textContent ?? "";
    expect(text).toContain("chat.queue.title");
    expect(text).toContain("Reescrever a timeline");
    expect(text).toContain("esperando Ana terminar · limite de 3 agentes simultâneos cheio (A, B, C)");
    expect(text).toContain("chat.queue.ready");
    expect(text).toContain("src/features/chat/**");
  });

  it("cancelar tira a tarefa da tela e avisa o backend", async () => {
    await act(async () => { root.render(<TeamQueuePanel threadId="pai" />); });
    const cancel = [...host.querySelectorAll("button")].find((b) => b.textContent === "chat.queue.cancel") as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    expect(calls.some((c) => c.command === "chat_team_queue_cancel" && (c.args as { id: string }).id === "q1")).toBe(true);
    expect(host.textContent).not.toContain("Reescrever a timeline");
    expect(host.textContent).toContain("Docs");
  });
});

describe("o limite de agentes simultâneos", () => {
  it("nasce no padrão 3 e grava a escolha limitada à faixa", async () => {
    await act(async () => { root.render(<MaxAgentsSetting />); });
    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("3");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "99"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(input.value).toBe("12");
    expect(calls.some((c) => c.command === "db_set_setting" && JSON.stringify(c.args).includes("\"12\""))).toBe(true);
  });
});
