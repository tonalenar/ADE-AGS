// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/app/platform", () => ({ DESKTOP_OS: "macos" }));
vi.mock("@/features/chat/deviceDemand", () => ({ presentDeviceTool: (_host: string, _kind: string, _id: string, disabled: boolean, action: string) => ({ disabled: !disabled, label: action }) }));
vi.mock("@/features/recording/ScreenRecordButton", () => ({ ScreenRecordButton: () => <button type="button" aria-label="screenRecording.start" /> }));
vi.mock("../ipc", () => ({
  iphoneAppSwitcher: vi.fn(() => Promise.resolve()), iphoneCopyImage: vi.fn(() => Promise.resolve()),
  iphoneGesture: vi.fn(() => Promise.resolve()), iphoneScreenshot: vi.fn(() => Promise.resolve("shot.png")),
  iphoneType: vi.fn(() => Promise.resolve()), iphoneMirrorConnect: vi.fn(() => Promise.resolve()), iphoneMirrorDisconnect: vi.fn(() => Promise.resolve()),
  iphoneButton: vi.fn(() => Promise.resolve()),
}));

import { DeviceBar } from "../DeviceBar";

let root: Root | null = null;
let host: HTMLDivElement;

function render() {
  act(() => {
    root ??= createRoot(host);
    root.render(<DeviceBar device="device-mock" name="iPhone Mock" status={{ state: "live", transport: "wifi", fps: 30 } as never}
      ready disconnected={false} zoom="fit" onZoom={() => {}} onRefresh={() => {}} refreshing={false}
      onSession={() => {}} sessionBusy={false} fullscreen={false} onFullscreen={() => {}} />);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe("barra de controles físicos", () => {
  it("agrupa todas as ações, apresenta um status e mantém o teclado nomeado para acessibilidade", () => {
    render();
    expect(host.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("iphone.status.live");
    for (const label of [
      "iphone.search", "iphone.session.disconnect", "iphone.home", "iphone.bar.apps", "iphone.bar.shot",
      "screenRecording.start", "iphone.bar.rotateHint", "iphone.keyboard", "iphone.zoom.out", "iphone.zoom.in",
      "iphone.zoom.fit", "iphone.zoom.actual", "iphone.fullscreen.enter", "chat.devices.more",
    ]) {
      expect(host.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
  });

  it("no modo ajustar não mostra rótulo solto de zoom na coluna", () => {
    render();
    expect(host.textContent).not.toContain("iphone.zoom.fitShort");
    expect(host.querySelector('[aria-label="iphone.zoom.fit"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("mantém Sistema e Botões acessíveis no menu agrupado", () => {
    render();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="chat.devices.more"]')?.click());
    expect(host.textContent).toContain("iphone.system");
    expect(host.textContent).toContain("iphone.buttons");
    expect(host.textContent).toContain("iphone.gesture.controlCenter");
    expect(host.textContent).toContain("iphone.button.volumeUp");
  });

  it("fica em coluna à direita do aparelho e o menu «mais» abre para a esquerda e para cima, sem sair da janela", () => {
    render();
    const bar = host.querySelector('[role="toolbar"]');
    expect(bar?.getAttribute("aria-orientation")).toBe("vertical");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="chat.devices.more"]')?.click());
    const menu = host.querySelector('[role="menu"]');
    expect(menu?.className).toContain("right-full");
    expect(menu?.className).toContain("bottom-0");
    expect(menu?.className).toContain("max-h-[calc(100vh-96px)]");
  });
});
