/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ counts: { workspace: 0, byMission: {} as Record<string, number> }, load: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
}));
vi.mock("@/features/memory/MemoryPanel", () => ({ MemoryPanel: () => <div data-testid="memory-panel" /> }));
vi.mock("@/features/memory/pendingStore", () => {
  const store = Object.assign(
    (selector: (s: { counts: typeof mocks.counts }) => unknown) => selector({ counts: mocks.counts }),
    { getState: () => ({ load: mocks.load }) },
  );
  return { usePendingMemoryStore: store };
});

import { badgeText, MemoryRail, pendingTotal } from "../MemoryRail";

let host: HTMLDivElement;
let root: Root;

function mount() {
  act(() => root.render(<MemoryRail workspaceId="w" workspaceName="W" />));
}

beforeEach(() => {
  localStorage.clear();
  mocks.counts = { workspace: 0, byMission: {} };
  mocks.load.mockReset().mockResolvedValue(mocks.counts);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("contagem do balão", () => {
  it("soma o workspace e as missões", () => {
    expect(pendingTotal({ workspace: 2, byMission: { a: 3, b: 1 } })).toBe(6);
    expect(pendingTotal({ workspace: 0, byMission: {} })).toBe(0);
  });

  it("some sem pendências e vira 99+ acima de 99", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(150)).toBe("99+");
  });
});

describe("painel de memória recolhível", () => {
  it("nasce recolhido, sem balão quando não há pendências", () => {
    mount();
    expect(host.querySelector('[data-testid="memory-panel"]')).toBeNull();
    expect(host.querySelector('[data-testid="memory-rail-badge"]')).toBeNull();
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("mostra o total de pendências no balão do botão recolhido", () => {
    mocks.counts = { workspace: 3, byMission: { m1: 4 } };
    mount();
    expect(host.querySelector('[data-testid="memory-rail-badge"]')?.textContent).toBe("7");
    expect(host.querySelector("button")?.getAttribute("aria-label")).toContain('"count":7');
  });

  it("abre ao clicar, recolhe de novo e lembra a escolha", () => {
    mount();
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[data-testid="memory-panel"]')).not.toBeNull();
    expect(localStorage.getItem("ags.settings.memoryRail")).toBe("open");

    // Remontar lê a escolha guardada: segue aberto.
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(host.querySelector('[data-testid="memory-panel"]')).not.toBeNull();

    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[data-testid="memory-panel"]')).toBeNull();
    expect(localStorage.getItem("ags.settings.memoryRail")).toBe("closed");
  });

  it("carrega as contagens mesmo com o painel fechado", () => {
    mount();
    expect(mocks.load).toHaveBeenCalledWith("w");
  });
});
