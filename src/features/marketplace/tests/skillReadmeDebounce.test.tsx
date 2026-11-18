/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  marketplaceSkillReadme: vi.fn(),
}));

vi.mock("../ipc", () => ipc);

import { README_DEBOUNCE_MS, SkillReadmeCache, skillReadmeCache } from "../skillReadme";
import { useSkillReadme } from "../useSkillReadme";

function Probe({ registryId, skillId }: { registryId: string | null; skillId: string | null }) {
  const state = useSkillReadme(registryId, skillId);
  return <div data-loading={String(state.loading)} data-content={state.content ?? ""} />;
}

describe("SkillReadmeCache", () => {
  it("devolve o markdown já baixado sem nova leitura", () => {
    const cache = new SkillReadmeCache();
    cache.set("r", "s", "# Olá");
    expect(cache.get("r", "s")).toBe("# Olá");
    expect(cache.get("r", "outro")).toBeUndefined();
  });
});

describe("useSkillReadme debounce e cache", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    skillReadmeCache.clear();
    ipc.marketplaceSkillReadme.mockReset();
    ipc.marketplaceSkillReadme.mockResolvedValue("# remoto");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("espera o debounce antes de baixar, e reusa o cache na segunda montagem", async () => {
    await act(async () => {
      root.render(<Probe registryId="r" skillId="s" />);
    });
    expect(ipc.marketplaceSkillReadme).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(README_DEBOUNCE_MS - 1);
    });
    expect(ipc.marketplaceSkillReadme).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(ipc.marketplaceSkillReadme).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector("div")?.dataset.content).toBe("# remoto");

    await act(async () => {
      root.render(<Probe registryId="r" skillId="other" />);
    });
    await act(async () => {
      root.render(<Probe registryId="r" skillId="s" />);
    });
    expect(ipc.marketplaceSkillReadme).toHaveBeenCalledOnce();
    expect(host.querySelector("div")?.dataset.content).toBe("# remoto");
  });
});
