// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ answerAsk: vi.fn(), alwaysAllow: vi.fn() }));
vi.mock("@/features/chat/permissions/permissionsStore", () => store);
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/Users/ton") }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o?.target ? `${key}:${o.target}` : key), i18n: { language: "pt-BR" } }),
}));

import { ActivityLine } from "@/features/chat/LiveActivity";
import { PermissionCard } from "@/features/chat/permissions/PermissionCard";
import type { PendingAsk } from "@/features/chat/permissions/permissionModel";

const ask: PendingAsk = {
  id: "thread:q", ref: { source: "thread", threadId: "th", requestId: "q" }, agentId: "codex", agentLabel: "Codex", conversation: "thread:th",
  where: "ChatView + Composer", kind: "command", detail: "bun add @codemirror/lang-html", files: ["package.json", "bun.lock"], network: true,
  cwd: "/Users/ton/Projects/ADE-AGS", risk: "medium", canSession: true, atMs: 0,
};

let root: Root | null = null;
let host: HTMLDivElement;

function button(prefix: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith(prefix));
  expect(found, prefix).toBeDefined();
  return found!;
}

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.useRealTimers();
});

describe("cartão de permissão no fio", () => {
  it("mostra o comando, onde, a rede e o que mexe; cada botão responde", async () => {
    await render(<PermissionCard ask={ask} terminal />);
    expect(host.textContent).toContain("chat.permission.titleCommand");
    expect(host.querySelector("code")?.textContent).toBe("bun add @codemirror/lang-html");
    expect(host.textContent).toContain("chat.permission.network");
    expect(host.textContent).toContain("package.json");
    expect(host.textContent).toContain("chat.permission.noteTerminal");

    await act(async () => { button("chat.permission.deny").click(); });
    expect(store.answerAsk).toHaveBeenLastCalledWith(ask, "deny");
    await act(async () => { button("chat.permission.always").click(); });
    expect(store.alwaysAllow).toHaveBeenLastCalledWith(ask, "bun add *");
    await act(async () => { button("chat.permission.allow").click(); });
    expect(store.answerAsk).toHaveBeenLastCalledWith(ask, "allow");
  });

  it("Responder… nega e manda o texto ao agente", async () => {
    await render(<PermissionCard ask={ask} terminal={false} />);
    await act(async () => { button("chat.permission.reply").click(); });
    const box = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "use o pnpm");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("chat.permission.sendReply").click(); });
    expect(store.answerAsk).toHaveBeenLastCalledWith(ask, "deny", "use o pnpm");
  });

  it("N nega e ⏎ permite com o foco fora de um campo", async () => {
    await render(<PermissionCard ask={ask} terminal />);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })); });
    expect(store.answerAsk).toHaveBeenLastCalledWith(ask, "deny");
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(store.answerAsk).toHaveBeenLastCalledWith(ask, "allow");
  });

  it("risco alto não oferece regra", async () => {
    await render(<PermissionCard ask={{ ...ask, detail: "git push origin main", risk: "high" }} terminal />);
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.startsWith("chat.permission.always"))).toBe(false);
  });
});

describe("linha viva", () => {
  it("Ver o que está fazendo abre os últimos comandos e o raciocínio; Esconder fecha", async () => {
    vi.setSystemTime(60_000);
    const live = {
      startedAt: 8_000, tokens: 88_600, activity: { kind: "tool" as const, tool: "command" as const, target: "bun x tauri build --debug" },
      recent: [{ id: "a", tool: "command" as const, label: "bunx tsc --noEmit", status: "done" as const }], reasoning: "conferir o snap de 8 px",
    };
    await render(<ActivityLine live={live} startedAt={null} />);
    const status = host.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("chat.live.build:bun x tauri build --debug");
    expect(status.textContent).toContain("52 s");
    const toggle = button("chat.live.show");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { toggle.click(); });
    expect(host.textContent).toContain("› bunx tsc --noEmit ✓");
    expect(host.textContent).toContain("chat.live.reasoning");
    await act(async () => { button("chat.live.hide").click(); });
    expect(host.textContent).not.toContain("› bunx tsc");
  });
});
