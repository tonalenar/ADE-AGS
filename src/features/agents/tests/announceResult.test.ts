import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateAgentRestarting: vi.fn() }));

vi.mock("@/shared/brand/botToastStore", () => ({
  showBotToast: vi.fn(() => 1),
  useBotToastStore: { getState: () => ({ push: vi.fn(() => 1), update: vi.fn(), dismiss: vi.fn() }) },
}));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: { getState: () => ({ tabs: [], setDetectedAgents: vi.fn(), restartAgent: vi.fn() }) },
}));
vi.mock("@/features/terminal/ipc", () => ({ ptyForTab: vi.fn(), ptyKill: vi.fn() }));
vi.mock("@/app/closeWithSave", () => ({ exitAllWithSave: vi.fn() }));
vi.mock("@/shared/ipc/settings", () => ({ getSetting: vi.fn() }));
vi.mock("../ipc", () => ({
  agentUpdate: vi.fn(), agentUpdatesCheck: vi.fn(), agentUpdateWorkRunning: vi.fn(), detectAgents: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../updateFlow", () => ({ updateAgentRestarting: mocks.updateAgentRestarting }));

import { showBotToast } from "@/shared/brand/botToastStore";

import { announceResult, runAgentUpdate } from "../AgentUpdateWatcher";
import type { AgentUpdateInfo } from "../updatePolicy";

/** Um `t` que devolve a chave e os parâmetros, para o texto mostrar o que entrou. */
const t = ((key: string, opts?: Record<string, unknown>) => `${key} ${JSON.stringify(opts ?? {})}`) as unknown as TFunction;

const info: AgentUpdateInfo = {
  agentId: "codex", label: "Codex", currentVersion: "0.1.0", latestVersion: "0.2.0",
  updateAvailable: true, canAutoUpdate: true, busy: false, reason: null,
};

describe("announceResult: a causa da falha vai junto (I2 / A173)", () => {
  it("uma falha com causa mostra a causa, não só o motivo genérico", () => {
    vi.mocked(showBotToast).mockClear();
    announceResult(t, "Codex", { agentId: "codex", ok: false, output: "disco cheio", newVersion: null, error: "failed" });
    expect(showBotToast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("disco cheio") }));
  });
});

describe("runAgentUpdate: o reinício que falhou aparece para a pessoa (I1)", () => {
  it("com restartError, avisa em aviso (warning) com a causa", async () => {
    vi.mocked(showBotToast).mockClear();
    mocks.updateAgentRestarting.mockResolvedValueOnce({
      result: { agentId: "codex", ok: true, output: "", newVersion: "0.2.0", error: null },
      reopened: 2,
      appRestarting: false,
      restartError: "sem permissão",
    });
    await runAgentUpdate(t, info);
    expect(showBotToast).toHaveBeenCalledWith(expect.objectContaining({
      tone: "warning",
      text: expect.stringContaining("sem permissão"),
    }));
  });
});
