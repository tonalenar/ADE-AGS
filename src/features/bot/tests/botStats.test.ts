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

describe("botStats: ventanas y pruebas", () => {
  const DAY = 86_400;
  const now = 100 * DAY;
  const at = (daysAgo: number) => now - daysAgo * DAY;
  const t = (id: string, status: MissionLike["status"], daysAgo: number, isTest?: boolean | null): MissionLike => ({
    ...m(id, status, at(daysAgo) - 60, at(daysAgo)), isTest,
  });

  it("separa 7 y 30 días por la fecha de cierre", () => {
    const s = botStats([
      t("a", "done", 1), t("b", "failed", 3), t("c", "done", 20), t("d", "failed", 60), t("e", "cancelled", 2), t("f", "cancelled", 40),
    ], now);
    expect(s.windows.d7).toEqual({ done: 1, failed: 1, cancelled: 1, successRate: 50 });
    expect(s.windows.d30).toEqual({ done: 2, failed: 1, cancelled: 1, successRate: 67 });
    expect(s.successRate).toBe(50); // histórico: 2 de 4
    expect(s.cancelled).toBe(2);
  });

  it("las marcadas como prueba salen de la tasa pero se cuentan; sin marca cuenta como real", () => {
    const s = botStats([t("a", "done", 1), t("b", "failed", 1, true), t("c", "failed", 1, null), t("d", "failed", 1, false)], now);
    expect(s.testCount).toBe(1);
    expect(s.successRate).toBe(33);
    expect(s.windows.d7).toMatchObject({ done: 1, failed: 2, successRate: 33 });
    expect(s.total).toBe(4);
  });

  it("no adivina por el título y sin cierres en la ventana da null", () => {
    const e2e: MissionLike = { ...m("x", "failed", 1, 2), title: "E2E test" };
    expect(botStats([e2e], now).successRate).toBe(0);
    const s = botStats([t("a", "done", 50), m("b", "draft", null, null)], now);
    expect(s.windows.d7.successRate).toBeNull();
    expect(s.windows.d30.successRate).toBeNull();
  });
});
