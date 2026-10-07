import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), sendWhenReady: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ sendWhenReady: mocks.sendWhenReady }));

import { injectTabMemory, memoryBlockFor, startupText, tabMemoryMessage } from "../tabMemory";

describe("injectTabMemory", () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.sendWhenReady.mockReset(); });
  it("desligado por padrão: não consulta nem envia", async () => {
    expect(await injectTabMemory({ id: "t", agentId: "codex" }, "ws")).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.sendWhenReady).not.toHaveBeenCalled();
  });
  it("ligado: envia o índice uma vez, achatado fora do Claude Code", async () => {
    mocks.invoke.mockResolvedValue("DADOS\n[\"a\"]\nFIM");
    expect(await injectTabMemory({ id: "t", agentId: "codex", memoryBlock: true }, "ws")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("memory_index", { workspaceId: "ws" });
    expect(mocks.sendWhenReady).toHaveBeenCalledWith("t", "DADOS | [\"a\"] | FIM");
  });
  it("shell: nunca consulta nem envia, mesmo com a flag ligada (P1)", async () => {
    mocks.invoke.mockResolvedValue("DADOS");
    expect(await injectTabMemory({ id: "t", agentId: "bash", memoryBlock: true }, "ws")).toBe(false);
    expect(await tabMemoryMessage({ id: "t", agentId: "bash", memoryBlock: true }, "ws")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.sendWhenReady).not.toHaveBeenCalled();
  });
  it("memoryBlockFor limpa a flag para o shell e mantém para TUI", () => {
    expect(memoryBlockFor("bash", true)).toBe(false);
    expect(memoryBlockFor("codex", true)).toBe(true);
    expect(memoryBlockFor("codex", false)).toBe(false);
  });
  it("tabMemoryMessage devolve o texto sem enviar (para juntar com o prompt)", async () => {
    mocks.invoke.mockResolvedValue("DADOS");
    expect(await tabMemoryMessage({ id: "t", agentId: "codex", memoryBlock: true }, "ws")).toBe("DADOS");
    expect(mocks.sendWhenReady).not.toHaveBeenCalled();
  });
  it("startupText junta memória e prompt em um só envio, prompt por último (P2)", () => {
    expect(startupText("MEM", "faça X")).toBe("MEM\n\nfaça X");
    expect(startupText(null, "faça X")).toBe("faça X");
    expect(startupText("MEM", undefined)).toBe("MEM");
    expect(startupText(null, undefined)).toBe("");
  });
  it("falha ou vazio: a tab abre normal", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("x"));
    expect(await injectTabMemory({ id: "t", agentId: "codex", memoryBlock: true }, "ws")).toBe(false);
    mocks.invoke.mockResolvedValueOnce("  ");
    expect(await injectTabMemory({ id: "t", agentId: "codex", memoryBlock: true }, "ws")).toBe(false);
    expect(mocks.sendWhenReady).not.toHaveBeenCalled();
  });
});
