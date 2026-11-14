// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useShallow } from "zustand/react/shallow";

import { useUiStore } from "../uiStore";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function Probe({ onRender }: { onRender: () => void }) {
  useUiStore(useShallow((state) => ({ chatMode: state.chatMode, shellMode: state.shellMode })));
  onRender();
  return null;
}

function BroadProbe({ onRender }: { onRender: () => void }) {
  useUiStore();
  onRender();
  return null;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("seletores Zustand do shell", () => {
  it("evita um render quando muda um campo fora do seletor", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let broadRenders = 0;
    let selectedRenders = 0;

    await act(async () => root?.render(<><BroadProbe onRender={() => { broadRenders += 1; }} /><Probe onRender={() => { selectedRenders += 1; }} /></>));
    const initialMission = useUiStore.getState().missionRequest;
    await act(async () => { useUiStore.setState({ missionRequest: "perf-selector" }); });

    expect(broadRenders).toBe(2);
    expect(selectedRenders).toBe(1);
    await act(async () => { useUiStore.setState({ missionRequest: initialMission }); });
  });
});
