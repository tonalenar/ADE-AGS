// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("../ipc", () => ({ iphoneButtonState: vi.fn().mockResolvedValue(undefined) }));

import { iphoneButtonState } from "../ipc";
import { DeviceFrame } from "../DeviceFrame";
import type { FrameLayout } from "../model";

const layout: FrameLayout = { buttons: [{ button: "volumeUp", side: "right", top: 0.1, height: 0.06, kind: "button" }], island: false, bezel: 0.05, radius: 0.1 };
let root: Root | null = null;
let host: HTMLDivElement;

function render(enabled: boolean) {
  act(() => {
    root ??= createRoot(host);
    root.render(
      <DeviceFrame device="device:x" name="iPhone" layout={layout} screen={{ width: 200, height: 400 }} enabled={enabled}>
        <i />
      </DeviceFrame>,
    );
  });
}

function button(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('button[aria-label="iphone.frame.volumeUp"]');
  if (!found) throw new Error("o botão lateral não apareceu");
  return found;
}

describe("botão lateral do aparelho", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // O happy-dom não implementa a captura do ponteiro; o botão só a usa para receber o soltar.
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    vi.mocked(iphoneButtonState).mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it("o soltar sai mesmo que a sessão tenha caído no meio do aperto", () => {
    render(true);
    act(() => { button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })); });
    expect(iphoneButtonState).toHaveBeenLastCalledWith("device:x", "volumeUp", true);

    // A sessão cai: o botão fica desabilitado enquanto a pessoa ainda segura o dedo.
    render(false);
    act(() => { button().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })); });

    expect(iphoneButtonState).toHaveBeenLastCalledWith("device:x", "volumeUp", false);
  });

  it("não aperta enquanto o toque não está pronto", () => {
    render(false);
    act(() => { button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })); });
    expect(iphoneButtonState).not.toHaveBeenCalled();
  });
});
