// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// A tela nativa fala com o Tauri; aqui basta um marcador.
vi.mock("@/features/simulator/SimulatorScreen", () => ({ NativeScreen: () => <i data-native="" /> }));
vi.mock("../ipc", () => ({ iphoneMirrorAttach: vi.fn(), iphoneMirrorPlace: vi.fn(), iphoneMirrorDetach: vi.fn() }));

import { PhysicalMirror } from "../PhysicalParts";
import { useIphoneStore } from "../store";

let root: Root | null = null;
let host: HTMLDivElement;

function render() {
  act(() => {
    root ??= createRoot(host);
    root.render(<PhysicalMirror screenId="tela" device="ipt" known status={{ state: "live" } as never} radius={8} onError={() => {}} />);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useIphoneStore.setState({ disconnectedDevices: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe("PhysicalMirror", () => {
  it("desconectar e reconectar o aparelho com o espelho aberto não quebra a tela (mesma ordem de hooks)", () => {
    render();
    expect(host.querySelector("[data-native]")).not.toBeNull();

    act(() => useIphoneStore.setState({ disconnectedDevices: ["ipt"] }));
    expect(host.textContent).toContain("iphone.session.paused");
    expect(host.querySelector("[data-native]")).toBeNull();

    act(() => useIphoneStore.setState({ disconnectedDevices: [] }));
    expect(host.querySelector("[data-native]")).not.toBeNull();
  });
});
