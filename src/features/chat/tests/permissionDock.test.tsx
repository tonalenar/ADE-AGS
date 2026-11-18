// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/Users/ton") }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "chat_request_answer") return Promise.resolve(true);
    if (cmd === "chat_permission_rule_add") {
      const input = args.input as { kind: string; pattern: string; agentId: string };
      return Promise.resolve({ id: "r1", kind: input.kind, pattern: input.pattern, agentId: input.agentId, role: null, teamId: null, createdAt: 1 });
    }
    if (cmd === "chat_permission_rules") return Promise.resolve([]);
    if (cmd === "chat_thread_send") return Promise.resolve(true);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import { ChatFrame } from "@/features/chat/ChatFrame";
import { PermissionCard } from "@/features/chat/permissions/PermissionCard";
import type { PendingAsk } from "@/features/chat/permissions/permissionModel";
import { usePermissions } from "@/features/chat/permissions/permissionsStore";
import { useStructured } from "@/features/chat/structured/store";
import { TimelineView } from "@/features/chat/timeline/ConversationTimeline";

class FakeObserver {
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() { /* nada */ }
}

const ask: PendingAsk = {
  id: "thread:q", ref: { source: "thread", threadId: "th", requestId: "q" }, agentId: "claude-code", agentLabel: "Claude Code", conversation: "thread:th",
  where: "Chat", kind: "command", detail: "cd ~/Projects/app && bun install", files: [], network: true,
  cwd: "/Users/ton/Projects/app", risk: "medium", canSession: true, atMs: 0,
};
const other: PendingAsk = { ...ask, id: "thread:r", ref: { source: "thread", threadId: "th", requestId: "r" }, detail: "ls" };
const LONG = `cd ~/Projects/nutriton-adapt; Q(){ supabase db query --remote=abc --read-only "$1" 2>&1 | python3 -I -c "${"x".repeat(400)}"`;

let root: Root;
let host: HTMLDivElement;

const mount = (node: React.ReactNode) => act(async () => { root.render(node); });
const button = (prefix: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(prefix));
  expect(found, prefix).toBeDefined();
  return found as HTMLButtonElement;
};

function lastAnswer() {
  const answers = ipc.calls.filter((c) => c.cmd === "chat_request_answer");
  return answers[answers.length - 1]?.args;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeObserver });
  ipc.calls = [];
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  usePermissions.setState({ rules: [], rulesLoaded: false, inboxOpen: false, filter: "all", selected: "thread:q", tui: [], answered: {} });
  useStructured.setState({ live: { th: { requests: [{ id: "q" }, { id: "r" }] } } } as never);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe("pedido de permissão junto do composer", () => {
  it("fica dentro da camada do composer, nunca na lista que rola por baixo dele", async () => {
    await mount(<ChatFrame
      list={() => <div data-testid="lista" />}
      composer={<div><PermissionCard ask={ask} terminal /><textarea aria-label="caixa" /></div>} />);
    const dock = host.querySelector("[data-permission-dock]") as HTMLElement;
    expect(dock).not.toBeNull();
    expect(dock.closest(".absolute.bottom-0")).not.toBeNull();
    expect(host.querySelector("[data-testid=lista]")!.contains(dock)).toBe(false);
  });

  it("a timeline com o pedido ancorado não repete o cartão nem o «Pensando…»", async () => {
    await mount(<TimelineView items={[{ kind: "user", id: "u", text: "rode" }, { kind: "assistant", id: "a", text: "vou rodar" }]}
      loaded working approval={null} approvalDocked agentLabel="Claude Code" agentId="claude-code" />);
    expect(host.querySelector("[data-permission-dock]")).toBeNull();
    // O agente espera a pessoa: a linha diz isso em vez de «Trabalhando…».
    expect(host.textContent).toContain("chat.timeline.waitingApproval");
  });

  it("é um grupo nomeado, com o comando numa caixa que rola e recebe foco", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    const group = host.querySelector("[data-permission-dock]") as HTMLElement;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("chat.permission.label");
    const code = host.querySelector("code") as HTMLElement;
    expect(code.tabIndex).toBe(0);
    expect(code.className).toContain("overflow-auto");
    expect(code.className).toContain("max-h-");
    expect(code.className).toContain("focus-visible:ring");
  });
});

describe("foco", () => {
  it("ao chegar, o foco vai para Permitir", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    expect(document.activeElement).toBe(button("chat.permission.allow"));
  });

  it("não rouba o foco de quem está digitando no composer", async () => {
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    await mount(<PermissionCard ask={ask} terminal />);
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it("um pedido novo leva o foco para o dele; digitando, continua onde estava", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    (document.activeElement as HTMLElement).blur();
    await mount(<PermissionCard ask={other} terminal />);
    expect(document.activeElement).toBe(button("chat.permission.allow"));

    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    await mount(<PermissionCard ask={ask} terminal />);
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it("os botões têm foco visível", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    for (const label of ["chat.permission.deny", "chat.permission.reply", "chat.permission.always", "chat.permission.allow"]) {
      expect(button(label).className, label).toContain("focus-visible:ring");
    }
  });
});

describe("atalhos", () => {
  const press = (key: string, target: EventTarget = document.body) =>
    act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

  it("N nega de fora de um campo; ⏎ só permite com o foco dentro do cartão (A161)", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    (document.activeElement as HTMLElement).blur();
    await press("n");
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "deny" });
    await press("Enter");
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "deny" });
    await press("Enter", document.querySelector("[data-permission-dock]") as HTMLElement);
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "allow" });
  });

  it("⏎ não aprova um comando colapsado, mesmo com o foco no cartão (A161)", async () => {
    await mount(<PermissionCard ask={{ ...ask, detail: LONG }} terminal />);
    await press("Enter", document.querySelector("[data-permission-dock]") as HTMLElement);
    expect(ipc.calls.filter((c) => c.cmd === "chat_request_answer")).toEqual([]);
    await act(async () => { button("chat.permission.expand").click(); });
    await press("Enter", document.querySelector("[data-permission-dock]") as HTMLElement);
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "allow" });
  });

  it("⏎ no botão Permitir não dispara o clique nativo quando o comando está colapsado (C1)", async () => {
    await mount(<PermissionCard ask={{ ...ask, detail: LONG }} terminal />);
    const allow = button("chat.permission.allow");
    const keepsDefault = allow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    // Cancelado (dispatchEvent devolve falso): o Enter não vira clique em Permitir.
    expect(keepsDefault).toBe(false);
    expect(ipc.calls.filter((c) => c.cmd === "chat_request_answer")).toEqual([]);
  });

  it("⏎ no botão Permitir segue o clique normal quando o comando está inteiro (C1)", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    const allow = button("chat.permission.allow");
    const keepsDefault = allow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(keepsDefault).toBe(true);
  });

  it("digitando no composer, as teclas são texto", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    const box = document.createElement("textarea");
    document.body.append(box);
    await press("n", box);
    await press("Enter", box);
    expect(ipc.calls.filter((c) => c.cmd === "chat_request_answer")).toEqual([]);
    box.remove();
  });

  it("Esc fecha o campo de resposta e devolve o foco ao botão Responder", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    await act(async () => { button("chat.permission.reply").click(); });
    const field = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    await press("Escape", field);
    expect(host.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button("chat.permission.reply"));
  });
});

describe("comando longo", () => {
  it("comando curto não oferece expandir", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    expect(host.querySelector("[aria-expanded][data-expand]")).toBeNull();
  });

  it("comando longo cabe numa altura limitada e expande sob pedido", async () => {
    await mount(<PermissionCard ask={{ ...ask, detail: LONG }} terminal />);
    const code = host.querySelector("code") as HTMLElement;
    const toggle = button("chat.permission.expand");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(code.className).toContain("max-h-24");
    await act(async () => { toggle.click(); });
    expect(button("chat.permission.collapse").getAttribute("aria-expanded")).toBe("true");
    expect(code.className).not.toContain("max-h-24");
    expect(code.className).toContain("max-h-64");
  });
});

describe("o contrato continua o mesmo", () => {
  it("Negar, Sempre permitir <padrão> e Permitir respondem; risco alto não oferece regra", async () => {
    await mount(<PermissionCard ask={ask} terminal />);
    expect(host.textContent).toContain("~/Projects/app");
    await act(async () => { button("chat.permission.deny").click(); });
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "deny" });
    await act(async () => { button("chat.permission.always").click(); });
    const added = ipc.calls.filter((c) => c.cmd === "chat_permission_rule_add");
    expect(added[added.length - 1]?.args).toEqual({
      input: { kind: "command", pattern: "cd *", agentId: "claude-code" },
    });
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "allow" });
    await act(async () => { button("chat.permission.allow").click(); });
    expect(lastAnswer()).toEqual({ requestId: "q", choice: "allow" });

    await mount(<PermissionCard ask={{ ...ask, detail: "git push origin main", risk: "high" }} terminal />);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.startsWith("chat.permission.always"))).toBe(false);
  });
});
