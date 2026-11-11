import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` é içado para o topo do arquivo: os mocks que ele usa também precisam estar lá.
const { chatThreadSend, agentSkillsScan } = vi.hoisted(() => ({
  chatThreadSend: vi.fn(async (_id: string, _text: string, _images?: string[]) => undefined),
  agentSkillsScan: vi.fn(async (_cwd: string | null, _agentId: string, _threadId?: string | null) => [
    { name: "deploy", description: "Publica o app", plugin: null, scope: "user" as const },
  ]),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/features/skills/ipc", () => ({ agentSkillsScan }));
vi.mock("../structured/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../structured/ipc")>()),
  chatThreadSend,
}));

import { sendToThread, useStructured } from "../structured/store";
import type { ThreadRow } from "../structured/ipc";

/** Espera as cadeias de promessas do envio sem usar relógio: só microtarefas. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function threadOf(agentId: string): ThreadRow {
  return {
    id: "t1", agentId, cwd: "/projeto", title: "Conversa", model: null, effort: null, access: "ask", accountId: null,
    state: "active", updatedAt: 0, createdAt: 0,
  } as unknown as ThreadRow;
}

describe("sendToThread: $nome no envio", () => {
  beforeEach(() => {
    chatThreadSend.mockClear();
    agentSkillsScan.mockClear();
  });

  it("o Claude recebe a menção do meio como /nome no início, com a skill da varredura da conta", async () => {
    useStructured.setState({ threads: [threadOf("claude-code")] });

    sendToThread("t1", "Use $deploy agora");
    await flush();

    expect(agentSkillsScan).toHaveBeenCalledWith("/projeto", "claude-code", "t1");
    expect(chatThreadSend).toHaveBeenCalledWith("t1", "/deploy Use agora", undefined);
  });

  it("o Codex manda o texto como foi escrito, sem consultar a varredura", async () => {
    useStructured.setState({ threads: [threadOf("codex")] });

    sendToThread("t1", "Use $deploy agora");
    await flush();

    expect(agentSkillsScan).not.toHaveBeenCalled();
    expect(chatThreadSend).toHaveBeenCalledWith("t1", "Use $deploy agora", undefined);
  });

  it("texto sem cifrão vai direto, sem varredura", async () => {
    useStructured.setState({ threads: [threadOf("claude-code")] });

    sendToThread("t1", "oi");
    await flush();

    expect(agentSkillsScan).not.toHaveBeenCalled();
    expect(chatThreadSend).toHaveBeenCalledWith("t1", "oi", undefined);
  });
});
