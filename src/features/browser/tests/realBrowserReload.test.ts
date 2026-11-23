import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ invoke: vi.fn((..._args: unknown[]) => Promise.resolve()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mock.invoke(...args) }));

import { realBrowserReloadNoCache, realBrowserShotSave } from "../realBrowser";

describe("recarregar o navegador sem cache", () => {
  beforeEach(() => mock.invoke.mockClear());

  it("pede ao backend um reload CDP sem cache para a vista escolhida", async () => {
    await realBrowserReloadNoCache("portal-1");

    expect(mock.invoke).toHaveBeenCalledWith("real_browser_reload", { id: "portal-1", ignoreCache: true });
  });
});

describe("foto do navegador direto para o arquivo", () => {
  beforeEach(() => mock.invoke.mockClear());

  it("uma única travessia do IPC devolve o caminho: nada de base64 de volta nem canvas", async () => {
    mock.invoke.mockResolvedValueOnce("/tmp/ade-ags/capturas/captura-agente-1-ab12cd34.png" as never);

    const path = await realBrowserShotSave("portal-1", "agente");

    expect(path).toBe("/tmp/ade-ags/capturas/captura-agente-1-ab12cd34.png");
    expect(mock.invoke).toHaveBeenCalledTimes(1);
    expect(mock.invoke).toHaveBeenCalledWith("real_browser_screenshot_save", { id: "portal-1", tag: "agente" });
  });
});
