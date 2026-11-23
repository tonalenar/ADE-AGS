/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const repoInfoMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/explorer/ipc", () => ({ repoInfo: repoInfoMock }));
vi.mock("@/app/afterFirstFrame", () => ({ afterFirstFrame: () => Promise.resolve() }));

import type { RepoInfo } from "@/features/explorer/types";
import { nextRepoRetryMs, useRepoInfo } from "../useRepoInfo";

const gitRepo: RepoInfo = {
  root: "/repo",
  branch: "dev",
  isWorktree: false,
  changes: { "a.ts": "M" },
  changedCount: 1,
};

const notRepo: RepoInfo = {
  root: null,
  branch: null,
  isWorktree: false,
  changes: {},
  changedCount: 0,
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe("useRepoInfo: timeout não entra no cache como sem repo", () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: Map<string, RepoInfo> = new Map();

  function Probe({ cwds }: { cwds: string[] }) {
    latest = useRepoInfo(cwds);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    repoInfoMock.mockReset();
    latest = new Map();
    setHidden(false);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    setHidden(false);
    vi.useRealTimers();
  });

  it("falha/timeout não grava 'sem repo' e tenta de novo com backoff até resolver", async () => {
    expect(nextRepoRetryMs(1)).toBe(3000);
    expect(nextRepoRetryMs(2)).toBe(6000);
    expect(nextRepoRetryMs(3)).toBe(12_000);
    expect(nextRepoRetryMs(4)).toBe(24_000);
    expect(nextRepoRetryMs(5)).toBe(30_000);

    repoInfoMock
      .mockRejectedValueOnce(new Error("git rev-parse excedeu o prazo de 15s"))
      .mockRejectedValueOnce(new Error("git status excedeu o prazo de 15s"))
      .mockResolvedValueOnce(gitRepo);

    await act(async () => { root.render(<Probe cwds={["/repo"]} />); });
    await flush();

    // Após 1º timeout: NÃO cacheou root: null.
    expect(repoInfoMock).toHaveBeenCalledTimes(1);
    expect(latest.has("/repo")).toBe(false);

    // Tenta de novo após 3 s (1º backoff).
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(repoInfoMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flush();
    expect(repoInfoMock).toHaveBeenCalledTimes(2);
    expect(latest.has("/repo")).toBe(false);

    // Após 2º timeout: backoff dobra para 6 s.
    await act(async () => { await vi.advanceTimersByTimeAsync(5999); });
    expect(repoInfoMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flush();
    expect(repoInfoMock).toHaveBeenCalledTimes(3);
    expect(latest.get("/repo")).toEqual(gitRepo);

    // Resolvido e cacheado: não relança mais.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(repoInfoMock).toHaveBeenCalledTimes(3);
  });

  it("pasta confirmada como sem repo pelo backend continua sendo cacheada", async () => {
    repoInfoMock.mockResolvedValueOnce(notRepo);
    await act(async () => { root.render(<Probe cwds={["/tmp/avulsa"]} />); });
    await flush();
    expect(latest.get("/tmp/avulsa")).toEqual(notRepo);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(repoInfoMock).toHaveBeenCalledTimes(1);
  });
});
