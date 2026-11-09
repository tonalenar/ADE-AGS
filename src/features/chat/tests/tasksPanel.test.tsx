// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invokeMock, useInvokeMock } from "@/test/invokeMock";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: "pt-BR" } }),
}));

import type { ConversationCard } from "../chatModel";
import { useChatStore } from "../store";
import { useStructured } from "../structured/store";
import type { ThreadRow } from "../structured/ipc";
import { TasksButton } from "../tasks/TasksButton";
import { TasksPanel } from "../tasks/TasksPanel";
import { receiveTask, receiveTaskItem, resetTasksForTest, tasksOf } from "../tasks/tasksStore";

useInvokeMock();

let root: Root;
let host: HTMLDivElement;
const NOW = 1_800_000_000_000;

const row = (id: string, agentId: string): ThreadRow => ({
  id, agentId, cwd: "/repo", title: "c", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1,
});
const card = (id: string, agentId = "claude-code"): ConversationCard => ({
  tabId: `thread:${id}`, title: "c", project: "repo", cwd: "/repo", branch: null, isWorktree: false, agentId, agentLabel: agentId, starting: false, active: true, openedAt: 1,
});
const mount = (node: React.ReactNode) => act(async () => { root.render(node); });
const byLabel = (label: string) => ([...host.querySelectorAll("[aria-label]")].find((el) => el.getAttribute("aria-label") === label) ?? null) as HTMLButtonElement | null;
const byLabelStart = (prefix: string) => [...host.querySelectorAll("[aria-label]")].filter((el) => el.getAttribute("aria-label")!.startsWith(prefix)) as HTMLButtonElement[];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetTasksForTest();
  invokeMock.on("db_get_setting", () => null);
  invokeMock.on("db_set_setting", () => undefined);
  useStructured.setState({ threads: [row("th-1", "claude-code"), row("th-o", "opencode")], live: {}, hydrated: {} });
  useChatStore.setState({ panel: "tasks", panelMaximized: false, thread: "th-1", composing: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

function seed() {
  receiveTask("th-1", { op: "started", taskId: "pai", kind: "agent", title: "Revisar o PR", toolUseId: "tp", stoppable: true, background: true, at: NOW - 559_000 });
  receiveTask("th-1", { op: "started", taskId: "f1", kind: "shell", title: "Rodar testes", parentTaskId: "pai", stoppable: true, background: true, at: NOW - 10_000 });
  receiveTask("th-1", { op: "started", taskId: "f2", kind: "agent", title: "Ler docs", parentTaskId: "pai", stoppable: true, background: true, at: NOW - 5_000 });
  receiveTask("th-1", { op: "started", taskId: "velha", kind: "shell", title: "Build", stoppable: true, background: true, at: NOW - 90_000 });
  receiveTask("th-1", { op: "ended", taskId: "velha", status: "failed", durationMs: 61_000, summary: "saiu com 1", at: NOW - 20_000 });
}

describe("o painel de tarefas", () => {
  it("mostra as que rodam com o tempo correndo, os filhos recolhidos e o Concluído fechado", async () => {
    seed();
    await mount(<TasksPanel conversation={card("th-1")} />);
    expect(host.textContent).toContain("chat.tasks.running");
    expect(byLabel('chat.tasks.openDetail:{"title":"Revisar o PR"}')).not.toBeNull();
    expect(host.textContent).toContain('chat.tasks.time.ms:{"m":9,"s":19}');
    // Os filhos ficam atrás do "2 tarefas".
    expect(byLabel('chat.tasks.openDetail:{"title":"Rodar testes"}')).toBeNull();
    const children = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.tasks.children"))!;
    expect(children.getAttribute("aria-expanded")).toBe("false");
    await click(children);
    expect(byLabel('chat.tasks.openDetail:{"title":"Rodar testes"}')).not.toBeNull();
    // O Concluído começa recolhido.
    const done = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.tasks.done"))!;
    expect(done.getAttribute("aria-expanded")).toBe("false");
    expect(byLabel('chat.tasks.openDetail:{"title":"Build"}')).toBeNull();
    await click(done);
    expect(host.textContent).toContain("chat.tasks.status.failed");
    expect(host.textContent).toContain('chat.tasks.time.ms:{"m":1,"s":1}');
    // O relógio anda sozinho.
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(host.textContent).toContain('chat.tasks.time.ms:{"m":9,"s":20}');
  });

  it("o parar manda o stop_task só daquela tarefa", async () => {
    seed();
    invokeMock.once("chat_task_stop", () => undefined);
    await mount(<TasksPanel conversation={card("th-1")} />);
    await click(byLabel('chat.tasks.stop:{"title":"Revisar o PR"}'));
    expect(invokeMock.calls("chat_task_stop")).toEqual([{ threadId: "th-1", taskId: "pai" }]);
  });

  it("o chevron abre o detalhe com o que o subagente fez, e a seta volta", async () => {
    seed();
    receiveTaskItem("th-1", "tp", { kind: "tool", id: "r", name: "Read", label: "src/a.ts", status: "done" });
    receiveTaskItem("th-1", "tp", { kind: "assistant", id: "m", text: "Achei dois problemas" });
    await mount(<TasksPanel conversation={card("th-1")} />);
    await click(byLabel('chat.tasks.openDetail:{"title":"Revisar o PR"}'));
    expect(host.textContent).toContain("chat.tasks.transcript");
    expect(host.textContent).toContain("Achei dois problemas");
    expect(host.textContent).toContain("src/a.ts");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("chat.tasks.back");
    await click(byLabel("chat.tasks.back"));
    expect(host.textContent).not.toContain("Achei dois problemas");
  });

  it("o detalhe de um shell lê a saída pelo chat_task_output", async () => {
    seed();
    invokeMock.on("chat_task_output", () => ({ output: "PASS 12 testes", total_bytes: 14, truncated: false }));
    await mount(<TasksPanel conversation={card("th-1")} />);
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.tasks.children"))!);
    await click(byLabel('chat.tasks.openDetail:{"title":"Rodar testes"}'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain("PASS 12 testes");
    expect(invokeMock.calls("chat_task_output")[0]).toEqual({ threadId: "th-1", taskId: "f1" });
    // A volta do detalhe mantém os filhos abertos e devolve o foco à linha.
    await click(byLabel("chat.tasks.back"));
    expect(byLabel('chat.tasks.openDetail:{"title":"Rodar testes"}')).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe('chat.tasks.openDetail:{"title":"Rodar testes"}');
  });

  it("a lixeira tira as concluídas; o fechar devolve o painel", async () => {
    seed();
    await mount(<TasksPanel conversation={card("th-1")} />);
    await click(byLabel("chat.tasks.clear"));
    expect(tasksOf("thread:th-1").order).toEqual(["pai", "f1", "f2"]);
    expect(byLabel("chat.tasks.clear")!.disabled).toBe(true);
    await click(byLabel("chat.tasks.maximize"));
    expect(useChatStore.getState().panelMaximized).toBe(true);
    await click(byLabel("chat.tasks.close"));
    expect(useChatStore.getState().panel).toBeNull();
  });

  it("no motor sem parar por tarefa, o botão fica desligado com o motivo", async () => {
    useStructured.setState((s) => ({ live: { ...s.live, "th-o": { items: [{ kind: "tool", id: "t1", tool: "task", name: "Task", label: "Explorar", status: "running", at: NOW - 3_000 }], requests: [], phase: "working", drafts: [], error: null, providerCommands: [], providerConfig: null } } }));
    await mount(<TasksPanel conversation={card("th-o", "opencode")} />);
    const [stop] = byLabelStart("chat.tasks.stopEngine");
    expect(stop!.disabled).toBe(true);
    expect(stop!.title).toBe("chat.tasks.stopEngine");
  });
});

describe("o botão do cabeçalho", () => {
  it("mostra quantas rodam, destaca quando uma começa e não abre o painel sozinho", async () => {
    useChatStore.setState({ panel: null });
    await mount(<TasksButton />);
    const button = () => host.querySelector("[data-tasks-button]") as HTMLButtonElement;
    expect(button().getAttribute("aria-label")).toBe("chat.tasks.title");
    await act(async () => { receiveTask("th-1", { op: "started", taskId: "a", title: "x", at: NOW, stoppable: true }); });
    expect(button().getAttribute("aria-label")).toBe('chat.tasks.openCount:{"count":1}');
    expect(button().textContent).toBe("1");
    expect(button().className).toContain("bg-accent-500/15");
    expect(useChatStore.getState().panel).toBeNull();
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(button().className).not.toContain("bg-accent-500/15");
    await click(button());
    expect(useChatStore.getState().panel).toBe("tasks");
  });
});
