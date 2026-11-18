import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

const structured = vi.hoisted(() => ({ answerRequest: vi.fn(), sendToThread: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@/i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn(() => Promise.resolve({})) }));
vi.mock("../structured/store", () => ({
  answerRequest: structured.answerRequest,
  sendToThread: structured.sendToThread,
  useStructured: create(() => ({ threads: [], live: {} })),
}));

import type { PendingAsk } from "../permissions/permissionModel";
import { answerAsk, usePermissions } from "../permissions/permissionsStore";

const ask: PendingAsk = {
  id: "thread:q1", ref: { source: "thread", threadId: "th", requestId: "q1" }, agentId: "codex", agentLabel: "Codex", conversation: "thread:th",
  where: "Conversa", kind: "command", detail: "bun add x", files: [], network: false, cwd: "/p", risk: "medium", canSession: true, atMs: 0,
} as PendingAsk;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  structured.answerRequest.mockReset();
  structured.sendToThread.mockReset().mockResolvedValue(true);
  usePermissions.setState({ answered: {}, selected: null } as never);
});

describe("o pedido só sai da caixa quando o backend aceita a resposta", () => {
  it("resposta_recusada_mantem_o_pedido: com o backend recusando, o pedido continua na lista", async () => {
    structured.answerRequest.mockResolvedValue(false);
    answerAsk(ask, "allow");
    await flush();
    expect(usePermissions.getState().answered[ask.id]).toBeUndefined();
  });

  it("resposta_aceita_tira_o_pedido_e_manda_o_texto: aceito, o pedido sai e o texto da resposta vai ao agente", async () => {
    structured.answerRequest.mockResolvedValue(true);
    answerAsk(ask, "deny", "use o pnpm");
    await flush();
    expect(usePermissions.getState().answered[ask.id]).toBe(true);
    expect(structured.sendToThread).toHaveBeenCalledWith("th", "use o pnpm");
  });
});
