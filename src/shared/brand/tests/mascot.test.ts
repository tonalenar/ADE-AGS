import { describe, expect, it } from "vitest";

import { eyeKindFor, eyeKindForState, eyeShapes, FAILED_WINDOW_MS, SLEEP_AFTER_MS, MASCOT_ARMS, MASCOT_BODY, MASCOT_FILL, MASCOT_LEGS, mascotStateFor } from "../Mascot";

describe("mascotStateFor", () => {
  it("sem nada na frota fica em repouso", () => {
    expect(mascotStateFor({ running: 0, needsYou: 0 })).toBe("idle");
  });

  it("com agentes rodando trabalha", () => {
    expect(mascotStateFor({ running: 2, needsYou: 0 })).toBe("working");
  });

  /// Esperando você pede uma ação; trabalhando, não. Por isso ganha mesmo com outros rodando.
  it("alguém esperando você vence quem está rodando", () => {
    expect(mascotStateFor({ running: 3, needsYou: 1 })).toBe("waiting");
  });
});

describe("sprite do mascote (silhueta de sempre)", () => {
  const cells = () => {
    const grid = new Map<string, string>();
    for (const r of MASCOT_BODY) for (let i = 0; i < r.w; i++) grid.set(`${r.x + i},${r.y}`, r.c);
    return grid;
  };

  it("cabe na grade 16×16 e todo papel tem cor", () => {
    for (const r of MASCOT_BODY) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(16);
      expect(r.y).toBeLessThan(16);
      expect(MASCOT_FILL[r.c]).toBeTruthy();
    }
  });

  it("mantém a silhueta da cabeça: arredondada, com antena", () => {
    const g = cells();
    // Cabeça: 10 de largura no topo, 14 no meio (cantos arredondados).
    expect([...Array(16).keys()].filter((x) => g.has(`${x},3`))).toHaveLength(10);
    expect([...Array(16).keys()].filter((x) => g.has(`${x},6`))).toHaveLength(14);
    expect([7, 8].map((x) => g.get(`${x},1`))).toEqual(["g", "g"]);
    // A cabeça termina na faixa de sombra (linha 10): as pernas saem dela.
    expect(Math.max(...MASCOT_BODY.map((r) => r.y))).toBe(10);
  });

  it("tem quatro perninhas coladas no corpo, com vão no meio", () => {
    const g = cells();
    expect(MASCOT_LEGS.xs).toHaveLength(4);
    for (const x of MASCOT_LEGS.xs) {
      // Nasce dentro da linha 10 (a faixa de sombra) e há corpo bem em cima dela: não descola.
      expect(MASCOT_LEGS.top).toBeLessThan(11);
      expect(MASCOT_LEGS.top).toBeGreaterThanOrEqual(10);
      expect(g.get(`${x},10`)).toBe("s");
    }
    const [, b, c] = MASCOT_LEGS.xs;
    expect(c - b - 1).toBeGreaterThanOrEqual(2);
  });

  it("os bracinhos são curtos e encostam na lateral da cabeça", () => {
    const g = cells();
    expect(MASCOT_ARMS.height).toBeLessThanOrEqual(2);
    const [left, right] = MASCOT_ARMS.xs;
    for (const y of [MASCOT_ARMS.top, MASCOT_ARMS.top + 1]) {
      expect(g.has(`${left + 1},${y}`) || g.has(`${left + 1},${MASCOT_ARMS.top}`)).toBe(true);
      expect(g.has(`${right - 1},${MASCOT_ARMS.top}`)).toBe(true);
    }
  });

  it("os olhos ficam dentro do visor", () => {
    const g = cells();
    for (const kind of ["block", "chevron", "closed", "x"] as const) {
      for (const e of eyeShapes(kind)) {
        for (let dx = 0; dx < e.w; dx++) {
          for (let dy = 0; dy < e.h; dy++) expect(g.get(`${e.x + dx},${e.y + dy}`)).toBe("v");
        }
      }
    }
  });

  it("do segundo estágio em diante os olhos viram chevron", () => {
    expect([1, 2, 3, 4].map(eyeKindFor)).toEqual(["block", "chevron", "chevron", "chevron"]);
    expect(eyeShapes("chevron")).toHaveLength(6);
  });
});

describe("humores novos: dormindo e falhou", () => {
  const quiet = { running: 0, needsYou: 0 };

  it("sem sinais de tempo o repouso continua sendo idle", () => {
    expect(mascotStateFor(quiet)).toBe("idle");
    expect(mascotStateFor(quiet, {})).toBe("idle");
  });

  it("dorme só depois de SLEEP_AFTER_MS parado", () => {
    expect(mascotStateFor(quiet, { idleMs: SLEEP_AFTER_MS - 1 })).toBe("idle");
    expect(mascotStateFor(quiet, { idleMs: SLEEP_AFTER_MS })).toBe("sleeping");
  });

  it("falha recente vence o sono no repouso", () => {
    expect(mascotStateFor(quiet, { recentFailure: true, idleMs: SLEEP_AFTER_MS * 2 })).toBe("failed");
  });

  it("pedir ação ou trabalhar vence falha e sono", () => {
    const tired = { recentFailure: true, idleMs: SLEEP_AFTER_MS * 2 };
    expect(mascotStateFor({ running: 1, needsYou: 0 }, tired)).toBe("working");
    expect(mascotStateFor({ running: 0, needsYou: 1 }, tired)).toBe("waiting");
  });

  it("os olhos seguem o humor: dormindo fecha, falhou faz X, o resto segue a etapa", () => {
    expect(eyeKindForState("sleeping", 4)).toBe("closed");
    expect(eyeKindForState("failed", 1)).toBe("x");
    expect(eyeKindForState("idle", 1)).toBe("block");
    expect(eyeKindForState("working", 3)).toBe("chevron");
  });

  it("a janela de falha é curta (minutos), não horas", () => {
    expect(FAILED_WINDOW_MS).toBeLessThan(SLEEP_AFTER_MS);
  });
});
