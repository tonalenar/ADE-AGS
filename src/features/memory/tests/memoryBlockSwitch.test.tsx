/** @vitest-environment happy-dom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MemoryBlockSwitch } from "../MemoryBlockSwitch";

describe("MemoryBlockSwitch", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const sw = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;

  function Harness({ onChange }: { onChange?: (v: boolean) => void }) {
    const [on, setOn] = useState(false);
    return <MemoryBlockSwitch checked={on} onChange={(v) => { setOn(v); onChange?.(v); }} />;
  }

  it("nasce desligado e é um botão nativo com rótulo e descrição", () => {
    act(() => root.render(<Harness />));
    expect(sw().tagName).toBe("BUTTON");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    const labelId = sw().getAttribute("aria-labelledby")!;
    expect(host.querySelector(`[id="${labelId}"]`)?.textContent).toBe("memoryBlock.label");
    const hintId = sw().getAttribute("aria-describedby")!;
    expect(host.querySelector(`[id="${hintId}"]`)?.textContent).toBe("memoryBlock.hintOff");
  });

  it("alterna ao clicar (Espaço/Enter acionam o clique do botão nativo)", () => {
    const seen: boolean[] = [];
    act(() => root.render(<Harness onChange={(v) => seen.push(v)} />));
    act(() => sw().click());
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("memoryBlock.hintOn");
    act(() => sw().click());
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(seen).toEqual([true, false]);
  });

  it("desabilitado não alterna", () => {
    const onChange = vi.fn();
    act(() => root.render(<MemoryBlockSwitch checked={false} onChange={onChange} disabled />));
    act(() => sw().click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("respeita reduced-motion e tem foco visível", () => {
    act(() => root.render(<Harness />));
    expect(sw().className).toContain("motion-reduce:transition-none");
    expect(sw().className).toContain("focus-visible:ring-2");
  });
});
