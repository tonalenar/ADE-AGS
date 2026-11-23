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

  it("girar mantém o raio, a moldura e o tamanho da ilha; a ilha vai para a lateral e os botões giram", () => {
    const withIsland: FrameLayout = { buttons: [{ button: "volumeUp", side: "right", top: 0.1, height: 0.06, kind: "button" }], island: true, bezel: 0.05, radius: 0.1 };
    const draw = (width: number, height: number) => {
      act(() => {
        root ??= createRoot(host);
        root.render(<DeviceFrame device="device:x" name="iPhone" layout={withIsland} screen={{ width, height }} enabled><i /></DeviceFrame>);
      });
      const island = host.querySelector<HTMLElement>('span[aria-hidden="true"].rounded-full')!;
      const screenBox = [...host.querySelectorAll<HTMLElement>("div")].find((d) => d.className.includes("overflow-hidden"))!;
      const outer = host.firstElementChild as HTMLElement;
      return { island, screenBox, outer, button: button() };
    };
    const portrait = draw(200, 400);
    const p = {
      radius: portrait.screenBox.style.borderRadius, w: portrait.island.style.width, h: portrait.island.style.height,
      top: portrait.island.style.top, buttonRight: portrait.button.style.right,
    };
    expect(p.top).not.toBe("");
    expect(p.buttonRight).not.toBe("");
    const land = draw(400, 200);
    expect(land.screenBox.style.borderRadius).toBe(p.radius);
    expect(land.outer.style.width).toBe("420px");
    expect(land.outer.style.height).toBe("220px");
    // A ilha deitada: largura e altura trocadas, junto da lateral esquerda, no meio da altura.
    expect(land.island.style.width).toBe(p.h);
    expect(land.island.style.height).toBe(p.w);
    expect(land.island.style.top).toBe("50%");
    expect(land.island.style.left).not.toBe("");
    // O botão da direita vai para a borda de cima.
    expect(land.button.style.top.startsWith("-")).toBe(true);
    expect(land.button.style.right).toBe("");
  });

  it("não aperta enquanto o toque não está pronto", () => {
    render(false);
    act(() => { button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })); });
    expect(iphoneButtonState).not.toHaveBeenCalled();
  });
});
