import { beforeEach, describe, expect, it, vi } from "vitest";

import { invokeMock, useInvokeMock } from "@/test/invokeMock";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));

import { clearGuideJob, guideJobKey, startGuide, useReviewGuideStore } from "../reviewGuideStore";
import type { GuideRequest } from "../types";

const req: GuideRequest = { agentId: null, accountId: null, autoAccount: true, model: null, lang: "pt-BR", workdir: null };

useInvokeMock();

describe("reviewGuideStore", () => {
  beforeEach(() => {
    useReviewGuideStore.setState({ jobs: {} });
  });

  it("um segundo pedido do mesmo PR enquanto o primeiro corre não chama o backend de novo", async () => {
    let finish: (v: unknown) => void = () => {};
    invokeMock.once("review_guide_generate", () => new Promise((r) => { finish = r; }));
    const first = startGuide("/repo", 1, req);
    await startGuide("/repo", 1, req);
    expect(invokeMock.calls("review_guide_generate")).toEqual([{ cwd: "/repo", number: 1, request: req }]);
    expect(useReviewGuideStore.getState().jobs[guideJobKey("/repo", 1)]?.status).toBe("running");
    finish({ entry: null, raw: "x", errors: ["e"], agentId: "codex", model: null });
    await first;
    const job = useReviewGuideStore.getState().jobs[guideJobKey("/repo", 1)];
    expect(job?.status === "done" && job.outcome.raw).toBe("x");
    clearGuideJob("/repo", 1);
    expect(useReviewGuideStore.getState().jobs).toEqual({});
  });

  it("um erro do backend vira a mensagem do job", async () => {
    invokeMock.once("review_guide_generate", () => Promise.reject({ kind: "api", message: "O guia deste PR já está sendo gerado." }));
    await startGuide("/repo", 2, req);
    const job = useReviewGuideStore.getState().jobs[guideJobKey("/repo", 2)];
    expect(job).toEqual({ status: "error", message: "O guia deste PR já está sendo gerado." });
  });
});
