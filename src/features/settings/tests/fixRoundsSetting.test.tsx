/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.hoisted(() => vi.fn());
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: (...a: unknown[]) => toast(...a) }));
vi.mock("@/shared/ipc/settings", () => ({
  getSetting: vi.fn(async () => { throw new Error("ipc"); }),
  setSetting: vi.fn(async () => undefined),
}));

import { FixRoundsSetting } from "../FixRoundsSetting";

describe("FixRoundsSetting", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    toast.mockReset();
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
});
