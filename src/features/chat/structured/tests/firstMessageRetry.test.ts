import { beforeEach, describe, expect, it, vi } from "vitest";

// O backend: a criação da conversa dá certo; o primeiro envio é recusado (o agente fechou antes), o segundo é aceito.
const backend = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, chatThreadCreate: backend.create, chatThreadSend: backend.send };
});

import { startThread, useStructured, type NewThread } from "../store";

const input: NewThread = { agentId: "claude-code", cwd: "/p/ade", title: "Pergunta", model: null, effort: null, access: "ask", accountId: null };

beforeEach(() => {
  useStructured.setState({ threads: [], live: {}, goals: {}, goalNotices: {}, hydrated: {}, hydrateErrors: {}, logFailures: {} });
  backend.create.mockReset().mockImplementation(() => Promise.resolve({ id: "t-new", state: "active", ...input }));
  backend.send.mockReset();
});

describe("a recusa da primeira mensagem não deixa conversa vazia a mais", () => {
  it("tentar de novo com a mesma entrada reaproveita a conversa que ficou sem mensagem aceita", async () => {
    backend.send.mockRejectedValueOnce(new Error("o agente fechou"));
    backend.send.mockResolvedValueOnce(undefined);
    const first = await startThread(input, "primeira");
    expect(first).toBeNull();
    const second = await startThread(input, "primeira");
    expect(second).toBe("t-new");
    expect(backend.create).toHaveBeenCalledTimes(1);
  });
});
