// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRevealedText } from "@/features/chat/timeline/useRevealedText";

let root: Root | null = null;
let host: HTMLDivElement;
let reduced = false;

function Probe({ id, text, animate }: { id: string; text: string; animate: boolean }) {
  const r = useRevealedText(id, text, animate);
  return <p data-revealing={String(r.revealing)}>{r.text}</p>;
}

function render(props: { id: string; text: string; animate: boolean }) {
  act(() => {
    root ??= createRoot(host);
    root.render(<Probe {...props} />);
  });
}

const shown = () => host.querySelector("p")!.textContent ?? "";
const revealing = () => host.querySelector("p")!.dataset.revealing === "true";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  reduced = false;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), media: q }));
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEXT = "Rodei os testes e todos passaram sem erro nenhum agora.";

describe("revelar a fala do agente", () => {
  it("a fala nova aparece palavra a palavra e termina inteira", () => {
    render({ id: "a1", text: TEXT, animate: true });
    expect(shown()).toBe("");
    act(() => { vi.advanceTimersByTime(100); });
    const partial = shown();
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(TEXT.length);
    expect(TEXT.startsWith(partial)).toBe(true);
    // Corte em fim de palavra.
    expect(partial.endsWith(" ") || /\s/.test(TEXT[partial.length] ?? " ")).toBe(true);
    act(() => { vi.advanceTimersByTime(1600); });
    expect(shown()).toBe(TEXT);
    expect(revealing()).toBe(false);
  });

  it("o histórico aparece inteiro, sem animação", () => {
    render({ id: "h1", text: TEXT, animate: false });
    expect(shown()).toBe(TEXT);
    expect(revealing()).toBe(false);
  });

  it("o rascunho que vira item final continua de onde parou, mesmo remontado", () => {
    render({ id: "d1", text: "Rodei os", animate: true });
    act(() => { vi.advanceTimersByTime(1600); });
    expect(shown()).toBe("Rodei os");
    // O item final chega (outro lugar do turno: remonta), sem marca de "novo".
    act(() => root?.unmount());
    root = null;
    render({ id: "d1", text: TEXT, animate: false });
    expect(shown()).toBe("Rodei os");
    act(() => { vi.advanceTimersByTime(1600); });
    expect(shown()).toBe(TEXT);
  });

  it("com movimento reduzido o texto aparece inteiro", () => {
    reduced = true;
    render({ id: "m1", text: TEXT, animate: true });
    expect(shown()).toBe(TEXT);
    expect(revealing()).toBe(false);
  });
});
