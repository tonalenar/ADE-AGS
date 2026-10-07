import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), sendWhenReady: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ sendWhenReady: mocks.sendWhenReady }));

import { injectTabMemory } from "../tabMemory";

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
  it("falha ou vazio: a tab abre normal", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("x"));
    expect(await injectTabMemory({ id: "t", agentId: "codex", memoryBlock: true }, "ws")).toBe(false);
    mocks.invoke.mockResolvedValueOnce("  ");
    expect(await injectTabMemory({ id: "t", agentId: "codex", memoryBlock: true }, "ws")).toBe(false);
    expect(mocks.sendWhenReady).not.toHaveBeenCalled();
  });
});
