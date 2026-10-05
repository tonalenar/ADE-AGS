import { describe, expect, it } from "vitest";

import { botStats, clock, missionSeconds, rankKey, recentMissions, scoreDigits, trophies, type MissionLike } from "../botStats";

const m = (id: string, status: MissionLike["status"], startedAt: number | null, endedAt: number | null, spentUsd = 0): MissionLike => ({
  id, title: id, status, startedAt, endedAt, spentUsd,
});

describe("botStats", () => {
  it("cuenta, suma la duración (las en curso hasta ahora) y el gasto", () => {
    const now = 10_000;
    const stats = botStats([
      m("a", "done", 1000, 1600, 0.5),
      m("b", "running", 9000, null, 0.25),
      m("c", "failed", 2000, 2100),
      m("d", "draft", null, null),
      m("e", "cancelled", 3000, 3010),
    ], now);
    expect(stats).toMatchObject({ total: 5, done: 1, running: 1, failed: 1, cancelled: 1, spentUsd: 0.75 });
    expect(stats.missionSeconds).toBe(600 + 1000 + 100 + 10);
    expect(stats.longestSeconds).toBe(1000);
    expect(stats.successRate).toBe(50);
  });

  it("sin misiones cerradas no inventa un porcentaje", () => {
    expect(botStats([m("a", "draft", null, null)], 0).successRate).toBeNull();
    expect(botStats([], 0)).toMatchObject({ total: 0, missionSeconds: 0, longestSeconds: 0, spentUsd: 0 });
  });

  it("una misión que nunca arrancó dura 0 y un reloj para atrás no da negativo", () => {
    expect(missionSeconds({ startedAt: null, endedAt: null }, 99)).toBe(0);
    expect(missionSeconds({ startedAt: 100, endedAt: 50 }, 99)).toBe(0);
  });
});

describe("rango y trofeos", () => {
  it("el rango sube con el nivel", () => {
    expect([1, 2, 4, 7, 12, 20].map(rankKey)).toEqual([
      "botPanel.rank.rookie", "botPanel.rank.apprentice", "botPanel.rank.hacker",
      "botPanel.rank.master", "botPanel.rank.boss", "botPanel.rank.legend",
    ]);
  });

  it("los trofeos salen de hitos reales", () => {
    const empty = botStats([], 0);
    expect(trophies(empty, 0, 1, 0).every((t) => !t.unlocked)).toBe(true);
    const rich = botStats(Array.from({ length: 10 }, (_, i) => m(`x${i}`, "done", 1, i === 0 ? 4001 : 11)), 0);
    const got = Object.fromEntries(trophies(rich, 150_000_000, 6, 4).map((t) => [t.id, t.unlocked]));
    expect(got).toMatchObject({ firstMission: true, tenMissions: true, marathon: true, squadFull: true, millionTokens: true, hundredMillion: true, level5: true, flawless: true });
  });
});

describe("formato de marcador", () => {
  it("reloj corto", () => {
    expect(clock(45)).toBe("45s");
    expect(clock(750)).toBe("12m 30s");
    expect(clock(3900)).toBe("1h 05m");
    expect(clock(-5)).toBe("0s");
  });

  it("ceros a la izquierda", () => {
    expect(scoreDigits(42)).toBe("000042");
    expect(scoreDigits(1234567)).toBe("1234567");
    expect(scoreDigits(Number.NaN)).toBe("000000");
  });

  it("las más recientes primero", () => {
    const list = [
      { ...m("viejo", "done", 10, 20), createdAt: 5 },
      { ...m("nuevo", "running", 100, null), createdAt: 90 },
      { ...m("borrador", "draft", null, null), createdAt: 50 },
    ];
    expect(recentMissions(list).map((x) => x.id)).toEqual(["nuevo", "borrador", "viejo"]);
  });
});

describe("failuresByClass", () => {
  it("cuenta solo las fallidas, por causa, y lo no clasificado como unknown", () => {
    const f = (id: string, category?: "access" | "timeout" | "crash"): MissionLike => ({ ...m(id, "failed", 1, 2), failureClassification: category ? { category, actionKey: "missions.failure.action.loginAgain" } : null });
    const s = botStats([f("a", "access"), f("b", "access"), f("c", "timeout"), f("d"), m("e", "done", 1, 2), { ...m("f", "done", 1, 2), failureClassification: { category: "crash", actionKey: "x" } }], 10);
    expect(s.failuresByClass).toEqual({ access: 2, timeout: 1, unknown: 1 });
  });

  it("casos de borda: categoria desconocida, vacía, o corrupta cae en unknown", () => {
    const f = (id: string, category: unknown): MissionLike => ({
      ...m(id, "failed", 1, 2),
      failureClassification: { category: category as any, actionKey: "missions.failure.action.unknown" },
    });
    const s = botStats([
      f("u1", "network_error"),
      f("u2", ""),
      f("u3", "403_forbidden"),
      f("u4", null),
      f("u5", undefined),
      f("u6", 12345),
    ], 10);
    expect(s.failuresByClass).toEqual({ unknown: 6 });
  });

  it("cubre todas las 5 categorías oficiales y no emite claves con 0", () => {
    const f = (id: string, category: "access" | "limit" | "model" | "crash" | "timeout"): MissionLike => ({
      ...m(id, "failed", 1, 2),
      failureClassification: { category, actionKey: `missions.failure.action.${category}` },
    });
    const s = botStats([
      f("a", "access"),
      f("l1", "limit"),
      f("l2", "limit"),
      f("m1", "model"),
      f("c1", "crash"),
      f("t1", "timeout"),
    ], 10);
    expect(s.failuresByClass).toEqual({
      access: 1,
      limit: 2,
      model: 1,
      crash: 1,
      timeout: 1,
    });
  });

  it("ignora clasificaciones si el status no es failed (draft, running, done, cancelled)", () => {
    const s = botStats([
      { ...m("d", "draft", null, null), failureClassification: { category: "access" as any, actionKey: "a" } },
      { ...m("r", "running", 10, null), failureClassification: { category: "limit" as any, actionKey: "l" } },
      { ...m("c", "cancelled", 10, 20), failureClassification: { category: "model" as any, actionKey: "m" } },
      { ...m("o", "done", 10, 20), failureClassification: { category: "crash" as any, actionKey: "k" } },
    ], 50);
    expect(s.failuresByClass).toEqual({});
  });

  it("lista vacía o sin misiones fallidas resulta en failuresByClass vacío", () => {
    expect(botStats([], 10).failuresByClass).toEqual({});
    expect(botStats([m("a", "done", 1, 2), m("b", "cancelled", 1, 2)], 10).failuresByClass).toEqual({});
  });
});
