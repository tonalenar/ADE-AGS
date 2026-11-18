// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ derived: 0 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/shared/useDocumentVisible", () => ({ useDocumentVisible: () => true }));
vi.mock("../tasks/tasksModel", async (importOriginal) => {
  const real = await importOriginal<typeof import("../tasks/tasksModel")>();
  return { ...real, tasksFromItems: (items: Parameters<typeof real.tasksFromItems>[0]) => { counts.derived += 1; return real.tasksFromItems(items); } };
});

import { useStructured } from "../structured/store";
import { useConversationTasks } from "../tasks/useConversationTasks";

/** Quem mostra as tarefas da conversa (o botão da barra e o painel): os dois leem a mesma lista de itens. */
function Reader() {
  useConversationTasks("thread:t1");
  return null;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  counts.derived = 0;
  useStructured.setState({ threads: [{ id: "t1", agentId: "opencode" }] as never, live: { t1: { items: [] } } as never, hydrated: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("as tarefas derivadas da timeline são calculadas uma vez por lista de itens", () => {
  it("o botão e o painel lendo a mesma conversa derivam as tarefas uma vez, não uma por leitor", async () => {
    await act(async () => { root.render(<><Reader /><Reader /></>); });
    expect(counts.derived).toBe(1);
  });
});
