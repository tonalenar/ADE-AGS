/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.hoisted(() => vi.fn());
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: toast }));
const ipc = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => Promise<string | null>>(async () => { throw new Error("ipc"); }),
  setSetting: vi.fn<(key: string, value: string) => Promise<void>>(async () => undefined),
}));
vi.mock("@/shared/ipc/settings", () => ipc);

import { FixRoundsSetting } from "../FixRoundsSetting";

describe("FixRoundsSetting", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    toast.mockReset();
    ipc.getSetting.mockReset();
    ipc.setSetting.mockReset();
    ipc.getSetting.mockRejectedValue(new Error("ipc"));
    ipc.setSetting.mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("avisa quando a leitura do teto falha", async () => {
    await act(async () => {
      root.render(<FixRoundsSetting />);
    });
    await act(async () => { await Promise.resolve(); });
    expect(toast).toHaveBeenCalledWith("settings.fixRounds.label", "settings.fixRounds.readError", "warning", 5000);
  });

  it("gravação falha não mostra [object Object]", async () => {
    ipc.getSetting.mockResolvedValue("2");
    ipc.setSetting.mockRejectedValue({ kind: "ipc" });
    await act(async () => {
      root.render(<FixRoundsSetting />);
    });
    await act(async () => { await Promise.resolve(); });
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const errorToast = toast.mock.calls.find((call) => call[2] === "error");
    expect(errorToast?.[1]).toBe("ipc");
    expect(String(errorToast?.[1])).not.toContain("[object Object]");
  });
});
