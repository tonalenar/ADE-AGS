/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn((_name: string, _args?: unknown) => Promise.resolve([] as unknown)),
  listeners: [] as ((e: { payload: unknown }) => void)[],
  pokes: [] as { tabId: string; text: string; timings: { onSent?: (at: number) => void } }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: unknown }) => void) => {
    mocks.listeners.push(cb);
    return Promise.resolve(() => {});
  },
}));
// O laço de tics fica desligado: o teste chama `vigiaTick` com o relógio que escolhe.
vi.mock("../repeatAfterEach", () => ({ repeatAfterEach: () => () => {} }));
vi.mock("../automation", () => ({ automationPausedFor: () => false, notePausedTeam: () => {} }));
// Uma missão com o time inteiro: o indexador devolve os integrantes da missão `m1`.
vi.mock("../groups", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  missionIndex: () => ({}),
  tabsByMission: (_index: unknown, tabs: { id: string }[]) => ({ m1: tabs.map((t) => t.id) }),
}));
// A cutucada não cola de verdade: o teste captura a chamada e dispara o `onSent` quando quiser.
vi.mock("@/features/terminal/safeWrite", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendAutonomous: (tabId: string, text: string, _source: string, timings: unknown) => {
    mocks.pokes.push({ tabId, text, timings: timings as { onSent?: (at: number) => void } });
  },
}));

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";

import { useMissionsStore } from "../store";
import { UNTASKED_MS, useVigiaDriver, vigiaTick } from "../vigia";
import { POKE_PENDING_MS } from "../vigiaPoke";
import { useVigiaSwitch } from "../vigiaSwitch";

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const LEAD = "lead";
const QA = "qa";
const MISSAO = "m1";

let host: HTMLDivElement;
let root: Root;

function Driver() {
  useVigiaDriver();
  return null;
}

/** O registro guardado da missão, como o Vigia o grava (é o que sobrevive a um reinício). */
function registroGuardado(): { nudges: number; lastNudge?: number } | undefined {
  const raw = JSON.parse(localStorage.getItem("ags.vigia.watches.v1") ?? "{}") as Record<string, { nudges: number; lastNudge?: number }>;
  return raw[MISSAO];
}

/** O último aviso que o Vigia escreveu no chat. */
function ultimoRelatorio(): string | undefined {
  const calls = mocks.invoke.mock.calls as unknown as [string, { text?: string } | undefined][];
  return calls.filter(([name]) => name === "vigia_report").at(-1)?.[1]?.text;
}

/** O Orquestrador manda uma mensagem ao integrante, como o backend emite em `cc-peer-message`. */
function delega(de: string, para: string, texto: string, atMs: number) {
  mocks.listeners[0]({ payload: { kind: "tell", fromTabId: de, toTabId: para, atMs, text: texto } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  localStorage.clear();
  localStorage.setItem("ags.vigia.enabled", "1");
  useVigiaSwitch.setState({ enabled: true });
  const startedSec = Math.floor((T0 - 2 * UNTASKED_MS) / 1000);
  useTabsStore.setState({
    tabs: [
      { id: LEAD, title: "Orquestrador", agentId: "codex", cwd: "/projeto", ptyId: 1 },
      { id: QA, title: "QA", agentId: "claude-code", cwd: "/projeto", ptyId: 2 },
    ] as never,
    detectedAgents: [],
  } as never);
  useMissionsStore.setState({
    missions: [{ id: MISSAO, title: "Missão E2E", status: "running", startedAt: startedSec, cwd: "/projeto" }] as never,
  } as never);
  useCanvasStore.setState({ boards: { "/projeto#m:m1": { orchestrators: [LEAD] } } as never } as never);
  mocks.pokes.length = 0;
  mocks.invoke.mockClear();
  mocks.listeners.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // Monta o driver só para registrar o ouvinte de `cc-peer-message`, e desmonta: o laço já está desligado.
  act(() => { root.render(<Driver />); });
  act(() => { root.unmount(); });
});

afterEach(() => {
  vi.useRealTimers();
  host.remove();
});

describe("vigiaTick: o incremento do lembrete entra no registro atual (A168)", () => {
  it("um lembrete que sai depois de o tick trocar o registro conta no registro guardado e no relatório", () => {
    // 1) Primeiro lembrete: a equipe não recebeu tarefa.
    vigiaTick(T0);
    expect(mocks.pokes).toHaveLength(1);
    mocks.pokes[0].timings.onSent?.(T0);
    expect(registroGuardado()?.nudges).toBe(1);
    expect(ultimoRelatorio()).toContain("lembrete 1/");

    // 2) Passado o silêncio mínimo, o Vigia cutuca de novo. Essa cutucada captura o registro que existe agora.
    const t2 = T0 + POKE_PENDING_MS + 1;
    vi.setSystemTime(t2);
    vigiaTick(t2);
    expect(mocks.pokes).toHaveLength(2);

    // 3) Antes de a cutucada sair, o Orquestrador delega ao QA. O tick seguinte troca o registro.
    delega(LEAD, QA, "Implemente a API de login", t2 + 1_000);
    const t3 = t2 + 2_000;
    vi.setSystemTime(t3);
    vigiaTick(t3);
    expect(registroGuardado()?.nudges).toBe(0);

    // 4) A cutucada que estava na fila sai agora. O lembrete tem de contar no registro guardado (o novo).
    mocks.pokes[1].timings.onSent?.(t3);
    const guardado = registroGuardado();
    expect(guardado?.nudges).toBe(1);
    expect(guardado?.lastNudge).toBe(t3);
    expect(ultimoRelatorio()).toContain("lembrete 1/");
  });
});
