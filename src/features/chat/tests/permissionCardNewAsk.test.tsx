// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ answerAsk: vi.fn(), alwaysAllow: vi.fn() }));
vi.mock("@/features/chat/permissions/permissionsStore", () => store);
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/Users/ton") }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import { PermissionCard } from "@/features/chat/permissions/PermissionCard";
import type { PendingAsk } from "@/features/chat/permissions/permissionModel";

const askOf = (id: string, detail: string): PendingAsk => ({
  id: `thread:${id}`, ref: { source: "thread", threadId: "th", requestId: id }, agentId: "codex", agentLabel: "Codex", conversation: "thread:th",
  where: "Conversa", kind: "command", detail, files: [], network: false, cwd: "/Users/ton/p", risk: "medium", canSession: true, atMs: 0,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const button = (prefix: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith(prefix)) as HTMLButtonElement;

describe("«Responder…» de um pedido não passa para o próximo pedido no mesmo cartão", () => {
  it("resposta_nao_passa_ao_proximo_pedido: trocar de pedido fecha o campo de resposta do anterior", async () => {
    await act(async () => { root.render(<PermissionCard ask={askOf("a", "bun add x")} terminal={false} />); });
    await act(async () => { button("chat.permission.reply").click(); });
    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "texto para o pedido A");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // O mesmo cartão recebe outro pedido (o anterior foi respondido).
    await act(async () => { root.render(<PermissionCard ask={askOf("b", "bun add y")} terminal={false} />); });
    expect(host.querySelector("textarea")).toBeNull();
  });
});
