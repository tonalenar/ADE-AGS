import { describe, expect, it } from "vitest";
import { findStalls, isWorking, STALL_MS, type PendingTasks } from "../stalled";

/** AGS-022: agente trabalhando (spinner, "esc to interrupt") não é agente parado. */
describe("agente trabalhando não dispara o aviso de parado", () => {
  const now = 10_000_000;
  const pending: PendingTasks = new Map([["t1", { tabId: "t1", fromTabId: "lead", at: now - STALL_MS - 60_000, alerted: false }]]);
  const probe = (screen: string[] | null) => ({
    now,
    isActive: () => false,
    lastOutputAt: () => undefined,
    lastInputAt: () => undefined,
    screen: () => screen,
  });

  it("reconhece a tela de trabalho", () => {
    expect(isWorking(["• Working (4m 39s • esc to interrupt)"])).toBe(true);
    expect(isWorking(["Running hooks… 3s"])).toBe(true);
    expect(isWorking(["> "])).toBe(false);
  });

  it("não avisa enquanto a tela mostra trabalho, e avisa quando não mostra", () => {
    expect(findStalls(pending, probe(["• Working (4m 39s • esc to interrupt)"]))).toEqual([]);
    expect(findStalls(pending, probe(["> "])).length).toBe(1);
  });
});
