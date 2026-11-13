import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ invoke: vi.fn((..._args: unknown[]) => Promise.resolve()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mock.invoke(...args) }));

import { realBrowserReloadNoCache } from "../realBrowser";

describe("recarregar o navegador sem cache", () => {
  beforeEach(() => mock.invoke.mockClear());

  it("pede ao backend um reload CDP sem cache para a vista escolhida", async () => {
    await realBrowserReloadNoCache("portal-1");

    expect(mock.invoke).toHaveBeenCalledWith("real_browser_reload", { id: "portal-1" });
  });
});
