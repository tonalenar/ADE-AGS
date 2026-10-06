import { describe, expect, it } from "vitest";

import { allWorkingSpan, startEventSpan, startupProgress, withActivity, type StartupState } from "../startup";

const base = (): StartupState => ({ openedAt: 1000, names: ["Orquestrador", "Backend", "QA"], activityAt: new Map() });

describe("startupProgress", () => {
  it("lista quem falta arrancar e não mede enquanto faltar alguém", () => {
    const s = withActivity(base(), "Backend", 5000);
    expect(startupProgress(s)).toEqual({ allWorkingMs: null, allWorkingAt: null, pendingNames: ["Orquestrador", "QA"] });
  });
  it("com todos ativos, o tempo vai até o ÚLTIMO a arrancar", () => {
    let s = base();
    s = withActivity(s, "Orquestrador", 4000);
    s = withActivity(s, "QA", 91_000);
    s = withActivity(s, "Backend", 30_000);
    expect(startupProgress(s)).toEqual({ allWorkingMs: 90_000, allWorkingAt: 91_000, pendingNames: [] });
  });
  it("sem agentes não há tempo", () => {
    expect(startupProgress({ openedAt: 0, names: [], activityAt: new Map() }).allWorkingMs).toBeNull();
  });
});

describe("withActivity", () => {
  it("só a primeira atividade conta e nomes desconhecidos são ignorados", () => {
    const s = withActivity(base(), "QA", 5000);
    expect(withActivity(s, "QA", 9000).activityAt.get("QA")).toBe(5000);
    expect(withActivity(s, "Intruso", 9000)).toBe(s);
  });
  it("não muta o estado anterior", () => {
    const s = base();
    withActivity(s, "QA", 5000);
    expect(s.activityAt.size).toBe(0);
  });
});

describe("spans", () => {
  it("evento pontual: início == fim e actor = nome", () => {
    expect(startEventSpan("start_retry", "QA", 7000)).toEqual({ kind: "start_retry", actor: "QA", startedMs: 7000, endedMs: 7000, detail: "" });
  });
  it("start_all_working só existe quando todos arrancaram", () => {
    expect(allWorkingSpan(withActivity(base(), "QA", 5000))).toBeNull();
    let s = base();
    for (const [i, n] of s.names.entries()) s = withActivity(s, n, 2000 + i * 1000);
    expect(allWorkingSpan(s)).toEqual({ kind: "start_all_working", actor: "all", startedMs: 1000, endedMs: 4000, detail: "" });
  });
});
