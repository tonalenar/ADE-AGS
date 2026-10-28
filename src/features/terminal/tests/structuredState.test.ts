import { afterEach, describe, expect, it } from "vitest";

import { findStalls, isWorking, STALL_MS, type PendingTasks, type StallProbe } from "@/features/missions/stalled";
import { findScreenAsks, SCREEN_QUESTION_QUIET_MS, type LeadStallProbe } from "@/features/missions/leadStall";

import {
  applyStateEvent,
  combineWorking,
  setStructuredForTests,
  structuredVerdict,
  workingWith,
  type StructuredSnapshot,
} from "../structuredState";

function snap(over: Partial<StructuredSnapshot> = {}): StructuredSnapshot {
  return { tabId: "a", agentId: "codex", mode: "veto", phase: "working", stale: false, tools: [], question: null, endsWithQuestion: false, ...over };
}

afterEach(() => setStructuredForTests([]));

describe("structuredVerdict", () => {
  it("só dá veredito com canal ligado, fase conhecida e estado fresco", () => {
    expect(structuredVerdict(snap())).toBe(true);
    expect(structuredVerdict(snap({ phase: "idle" }))).toBe(false);
    expect(structuredVerdict(snap({ phase: "unknown" }))).toBeNull();
    expect(structuredVerdict(snap({ stale: true }))).toBeNull();
    expect(structuredVerdict(snap({ mode: "off" }))).toBeNull();
    expect(structuredVerdict(undefined)).toBeNull();
  });
});

describe("combineWorking", () => {
  it("sem veredito, vale a tela (comportamento de antes)", () => {
    expect(combineWorking(true, null, "veto")).toBe(true);
    expect(combineWorking(false, null, "full")).toBe(false);
    expect(combineWorking(false, true, undefined)).toBe(false);
    expect(combineWorking(false, true, "off")).toBe(false);
  });

  it("em veto, o transcript só soma: nunca faz parecer parado quem a tela mostra trabalhando", () => {
    expect(combineWorking(false, true, "veto")).toBe(true);
    expect(combineWorking(true, false, "veto")).toBe(true);
  });

  it("em full, o transcript vence quando sabe", () => {
    expect(combineWorking(true, false, "full")).toBe(false);
    expect(combineWorking(false, true, "full")).toBe(true);
  });
});

describe("applyStateEvent e workingWith", () => {
  it("o evento de remoção tira a aba do canal", () => {
    const map = new Map<string, StructuredSnapshot>();
    applyStateEvent(map, snap());
    expect(map.get("a")?.phase).toBe("working");
    applyStateEvent(map, { tabId: "a", removed: true });
    expect(map.has("a")).toBe(false);
  });

  it("combina a tela com o estado guardado da aba", () => {
    setStructuredForTests([snap({ tabId: "a" }), snap({ tabId: "b", phase: "idle", mode: "full" })]);
    expect(workingWith("a", false)).toBe(true);
    expect(workingWith("b", true)).toBe(false);
    expect(workingWith("sem-canal", true)).toBe(true);
    expect(workingWith("sem-canal", false)).toBe(false);
  });
});

describe("detectores com o transcript", () => {
  const pending: PendingTasks = new Map([["a", { tabId: "a", fromTabId: "lead", at: 1000, alerted: false }]]);
  const probe = (over: Partial<StallProbe> = {}): StallProbe => ({
    now: 1000 + STALL_MS + 1,
    isActive: () => false,
    lastOutputAt: () => undefined,
    lastInputAt: () => undefined,
    screen: () => ["> "],
    ...over,
  });

  it("agente com o turno aberto no transcript e a tela quieta não é parado", () => {
    setStructuredForTests([snap({ tabId: "a" })]);
    const working = (id: string, lines: readonly string[]) => workingWith(id, isWorking(lines));
    expect(findStalls(pending, probe({ working }))).toEqual([]);
    expect(findStalls(pending, probe())).toHaveLength(1);
  });

  it("sem canal, o probe com `working` dá o mesmo que antes", () => {
    const working = (id: string, lines: readonly string[]) => workingWith(id, isWorking(lines));
    expect(findStalls(pending, probe({ working }))).toEqual(findStalls(pending, probe()));
  });

  it("pergunta velha na tela de quem está no meio de um turno não abre pedido ao orquestrador", () => {
    const lead: LeadStallProbe = {
      now: 1000 + SCREEN_QUESTION_QUIET_MS + 1,
      isActive: () => false,
      isWorking: (id) => workingWith(id, false),
      lastOutputAt: () => 1000,
      lastInputAt: () => undefined,
      screen: () => ["Posso rodar os testes agora?"],
    };
    const members = new Map([["a", "lead"]]);
    expect(findScreenAsks(members, new Map(), lead)).toHaveLength(1);
    setStructuredForTests([snap({ tabId: "a" })]);
    expect(findScreenAsks(members, new Map(), lead)).toEqual([]);
  });
});
