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

  it("casos de borda de tiempo: límites exactos de 7 y 30 días", () => {
    const exact7 = { ...m("e7", "done", now - 7 * DAY - 10, now - 7 * DAY) }; // exactamente en el límite de 7d
    const justPast7 = { ...m("p7", "done", now - 7 * DAY - 20, now - 7 * DAY - 1) }; // 1s fuera de 7d, pero dentro de 30d
    const exact30 = { ...m("e30", "failed", now - 30 * DAY - 10, now - 30 * DAY) }; // exactamente en el límite de 30d
    const justPast30 = { ...m("p30", "failed", now - 30 * DAY - 20, now - 30 * DAY - 1) }; // 1s fuera de 30d

    const s = botStats([exact7, justPast7, exact30, justPast30], now);
    // d7: solo exact7
    expect(s.windows.d7).toEqual({ done: 1, failed: 0, cancelled: 0, successRate: 100 });
    // d30: exact7, justPast7 (2 done) y exact30 (1 failed) -> 2/3 = 67%
    expect(s.windows.d30).toEqual({ done: 2, failed: 1, cancelled: 0, successRate: 67 });
    // total histórico: 2 done, 2 failed -> 50%
    expect(s.successRate).toBe(50);
  });

  it("misiones canceladas nunca afectan la tasa de éxito ni en ventanas ni en histórico", () => {
    const s = botStats([
      t("d1", "done", 1),
      t("c1", "cancelled", 1),
      t("c2", "cancelled", 2),
      t("c3", "cancelled", 15),
      t("c4", "cancelled", 45),
    ], now);
    // 1 done y 0 failed: tasa es 100%, las canceladas no devalúan la tasa
    expect(s.windows.d7).toEqual({ done: 1, failed: 0, cancelled: 2, successRate: 100 });
    expect(s.windows.d30).toEqual({ done: 1, failed: 0, cancelled: 3, successRate: 100 });
    expect(s.cancelled).toBe(4);
    expect(s.successRate).toBe(100);

    // Si solo hay canceladas, successRate es null (no 0)
    const onlyCancelled = botStats([t("c1", "cancelled", 1), t("c2", "cancelled", 10)], now);
    expect(onlyCancelled.windows.d7.successRate).toBeNull();
    expect(onlyCancelled.windows.d30.successRate).toBeNull();
    expect(onlyCancelled.successRate).toBeNull();
  });

  it("isTest: solo true las excluye de ventanas y tasa; null, undefined o false son reales", () => {
    const s = botStats([
      t("real1", "done", 2, undefined),
      t("real2", "done", 3, null),
      t("real3", "failed", 4, false),
      t("test1", "failed", 1, true),
      t("test2", "done", 2, true),
      { ...m("test_title", "failed", at(1) - 60, at(1)), title: "[TEST] E2E Integration Suite", isTest: null },
    ], now);

    // real1 (done), real2 (done), real3 (failed), test_title (failed) -> 4 reales en d7 (2 done, 2 failed -> 50%)
    expect(s.testCount).toBe(2);
    expect(s.total).toBe(6);
    expect(s.windows.d7.done).toBe(2);
    expect(s.windows.d7.failed).toBe(2);
    expect(s.windows.d7.successRate).toBe(50);
    expect(s.successRate).toBe(50);

    // Si todas son de prueba, la tasa es null
    const allTests = botStats([t("t1", "done", 1, true), t("t2", "failed", 1, true)], now);
    expect(allTests.testCount).toBe(2);
    expect(allTests.successRate).toBeNull();
    expect(allTests.windows.d7.successRate).toBeNull();
  });

  it("misiones sin endedAt usan startedAt para fecha de cierre o caen fuera si no tienen fechas", () => {
    const cancelledWithoutEnd: MissionLike = { ...m("c", "cancelled", at(3), null) };
    const draftWithoutDates: MissionLike = { ...m("d", "draft", null, null) };

    const s = botStats([cancelledWithoutEnd, draftWithoutDates], now);
    expect(s.windows.d7.cancelled).toBe(1);
    expect(s.windows.d7.successRate).toBeNull();
    expect(s.windows.d30.cancelled).toBe(1);
    expect(s.total).toBe(2);
  });
});
