/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getPendingCounts: vi.fn(),
  sustainedTabIds: vi.fn(),
}));
vi.mock("@/features/memory/ipc", () => ({ getPendingCounts: mocks.getPendingCounts }));
vi.mock("@/features/terminal/activity", () => ({ sustainedTabIds: mocks.sustainedTabIds }));
const live = vi.hoisted(() => ({ tabs: [] as unknown[], index: {} as Record<string, string> }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: (sel: (s: { tabs: unknown[]; workspaceId: string }) => unknown) => sel({ tabs: live.tabs, workspaceId: "w" }) }));
vi.mock("@/features/runs/store", () => ({ useRunsStore: (sel: (s: { tasks: never[]; approvals: never[] }) => unknown) => sel({ tasks: [], approvals: [] }) }));
vi.mock("@/features/missions/groups", () => ({ useMissionIndex: () => live.index }));
vi.mock("../PlatformLogo", () => ({ PlatformLogo: () => null }));
const i18n = vi.hoisted(() => ({ language: "pt-BR", resolvedLanguage: "pt-BR" }));
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n }) }));
vi.mock("../liveArcadeDraw", async (importOriginal) => {
  const real = await importOriginal<typeof import("../liveArcadeDraw")>();
  return { ...real, drawArcade: vi.fn() };
});
const towerCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../liveArcadeModel", async (importOriginal) => {
  const real = await importOriginal<typeof import("../liveArcadeModel")>();
  return {
    ...real,
    deriveTower: (input: Parameters<typeof real.deriveTower>[0]) => { towerCalls.count += 1; return real.deriveTower(input); },
  };
});

import type { MissionSummary } from "@/features/missions/types";
import { drawArcade } from "../liveArcadeDraw";
import { LiveArcade } from "../LiveArcade";

const mission = {
  id: "m1", title: "Missão", status: "running", activeRunId: null, budgetUsd: null, spentUsd: 0,
  activeSeconds: null, activeSource: null,
} as unknown as MissionSummary;

let host: HTMLDivElement;
let root: Root;
let queue: Map<number, FrameRequestCallback>;
let now: number;
let nextId: number;
let intervalSpy: ReturnType<typeof vi.spyOn>;

/** Um quadro de rAF falso: avança o relógio `ms` e roda só os callbacks que estavam na fila. */
async function frame(ms = 250) {
  now += ms;
  const due = [...queue.values()];
  queue.clear();
  await act(async () => {
    for (const cb of due) cb(now);
    await Promise.resolve();
  });
}

async function frames(count: number, ms = 250) {
  for (let i = 0; i < count; i += 1) await frame(ms);
}

async function remount() {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => {
    root.render(<LiveArcade mission={mission} tasks={[]} timings={null} review={null} tokens={null} />);
  });
}

/** Remonta com um herói na missão: é o caminho com animação, um rAF por quadro. */
async function remountWithHero() {
  live.tabs = [{ id: "t1", title: "Backend", agentId: "claude", sessionId: null }];
  live.index = { t1: "m1" };
  await remount();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.clearAllMocks();
  queue = new Map();
  now = 0;
  nextId = 1;
  towerCalls.count = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id: number) => { queue.delete(id); };
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => ({ setTransform() {} })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLElement.prototype.getBoundingClientRect = (() => ({ width: 960, height: 480, top: 0, left: 0, right: 960, bottom: 480, x: 0, y: 0, toJSON() {} })) as unknown as typeof HTMLElement.prototype.getBoundingClientRect;
  mocks.getPendingCounts.mockResolvedValue({ workspace: 0, byMission: {} });
  mocks.sustainedTabIds.mockReturnValue([]);
  live.tabs = [];
  live.index = {};
  intervalSpy = vi.spyOn(window, "setInterval");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<LiveArcade mission={mission} tasks={[]} timings={null} review={null} tokens={null} />);
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Ao vivo: um único laço de quadro", () => {
  it("não cria temporizadores de intervalo: os relógios andam pelo rAF ou por um temporizador", () => {
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it("sem herói, não agenda rAF", () => {
    expect(queue.size).toBe(0);
  });

  it("com prefers-reduced-motion, não agenda rAF mesmo com herói", async () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    await remountWithHero();
    expect(queue.size).toBe(0);
  });

  it("sem herói, relê a memória e as abas pelo temporizador", async () => {
    const memory = mocks.getPendingCounts.mock.calls.length;
    const tabs = mocks.sustainedTabIds.mock.calls.length;
    // O primeiro tique depois de montar não anda o relógio (dt 0): 6 s de tiques de 125 ms passam dos 5 s.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mocks.getPendingCounts.mock.calls.length).toBeGreaterThan(memory);
    expect(mocks.sustainedTabIds.mock.calls.length).toBeGreaterThan(tabs);
    expect(queue.size).toBe(0);
  });

  it("relê a memória pendente a cada 5 s, pelo laço", async () => {
    await remountWithHero();
    const before = mocks.getPendingCounts.mock.calls.length;
    // O primeiro quadro depois de montar não anda o relógio (dt 0): 25 quadros de 250 ms passam dos 5 s.
    await frames(25);
    expect(mocks.getPendingCounts.mock.calls.length).toBeGreaterThan(before);
  });

  it("relê as abas em esforço pelo laço", async () => {
    await remountWithHero();
    const before = mocks.sustainedTabIds.mock.calls.length;
    await frames(4);
    expect(mocks.sustainedTabIds.mock.calls.length).toBeGreaterThan(before);
  });

  it("com a aba oculta, para o laço e não lê mais nada", async () => {
    await remountWithHero();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(queue.size).toBe(0);
    const memory = mocks.getPendingCounts.mock.calls.length;
    const tabs = mocks.sustainedTabIds.mock.calls.length;
    await frames(20);
    expect(mocks.getPendingCounts.mock.calls.length).toBe(memory);
    expect(mocks.sustainedTabIds.mock.calls.length).toBe(tabs);
  });

  it("fora da vista, para o laço; de volta, retoma", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    await remountWithHero();
    expect(queue.size).toBe(1);
    const observer = callbacks[callbacks.length - 1];
    await act(async () => { observer([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(queue.size).toBe(0);
    await act(async () => { observer([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(queue.size).toBe(1);
  });

  it("com herói na tela, o desenho não passa de ~12 quadros por segundo", async () => {
    await remountWithHero();
    const draws = vi.mocked(drawArcade);
    const before = draws.mock.calls.length;
    await frames(63, 16);
    const perSecond = draws.mock.calls.length - before;
    expect(perSecond).toBeGreaterThanOrEqual(10);
    expect(perSecond).toBeLessThanOrEqual(13);
  });

  it("reutiliza o objeto de cada herói e o de rótulos entre quadros estáveis", async () => {
    await remountWithHero();
    await frames(2, 100);
    const draws = vi.mocked(drawArcade);
    const first = draws.mock.calls[draws.mock.calls.length - 1][1];
    await frames(30, 100);
    const last = draws.mock.calls[draws.mock.calls.length - 1][1];
    expect(last.heroes[0]).toBe(first.heroes[0]);
    expect(last.labels).toBe(first.labels);
  });

  it("em quadros estáveis, não recalcula a torre nem cria Set no desenho", async () => {
    await remountWithHero();
    await frames(2, 100);
    towerCalls.count = 0;
    // Só os Set criados pelo código do Ao vivo: o React em dev também cria os dele a cada commit.
    const NativeSet = Set;
    const limit = Error.stackTraceLimit;
    let sets = 0;
    Error.stackTraceLimit = 100;
    vi.stubGlobal("Set", class extends NativeSet<unknown> {
      constructor(values?: Iterable<unknown> | null) {
        super(values);
        if (new Error().stack?.includes("LiveArcade.tsx")) sets += 1;
      }
    });
    try {
      await frames(30, 100);
    } finally {
      Error.stackTraceLimit = limit;
    }
    expect(towerCalls.count).toBe(0);
    expect(sets).toBe(0);
  });
});
