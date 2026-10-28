import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { clearGuideJob, guideJobKey, startGuide, useReviewGuideStore } from "../reviewGuideStore";
import type { GuideRequest } from "../types";

const req: GuideRequest = { agentId: null, accountId: null, autoAccount: true, model: null, lang: "pt-BR", workdir: null };

describe("reviewGuideStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useReviewGuideStore.setState({ jobs: {} });
  });

  it("um segundo pedido do mesmo PR enquanto o primeiro corre não chama o backend de novo", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.invoke.mockReturnValue(new Promise((r) => { finish = r; }));
    const first = startGuide("/repo", 1, req);
    await startGuide("/repo", 1, req);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(useReviewGuideStore.getState().jobs[guideJobKey("/repo", 1)]?.status).toBe("running");
    finish({ entry: null, raw: "x", errors: ["e"], agentId: "codex", model: null });
    await first;
    const job = useReviewGuideStore.getState().jobs[guideJobKey("/repo", 1)];
    expect(job?.status === "done" && job.outcome.raw).toBe("x");
    clearGuideJob("/repo", 1);
    expect(useReviewGuideStore.getState().jobs).toEqual({});
  });

  it("um erro do backend vira a mensagem do job", async () => {
    mocks.invoke.mockRejectedValue({ kind: "api", message: "O guia deste PR já está sendo gerado." });
    await startGuide("/repo", 2, req);
    const job = useReviewGuideStore.getState().jobs[guideJobKey("/repo", 2)];
    expect(job).toEqual({ status: "error", message: "O guia deste PR já está sendo gerado." });
  });
});
