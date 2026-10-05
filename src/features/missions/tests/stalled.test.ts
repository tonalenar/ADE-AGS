import { describe, expect, it } from "vitest";

import {
  MIN_STALL_MS,
  STALL_MS,
  isAck,
  parseStallMs,
  applyMessage,
  findStalls,
  isWaitingForUser,
  lastScreenLine,
  markAlerted,
  stallMessage,
  type PeerMessage,
  type PendingTasks,
  type StallProbe,
} from "../stalled";

const isLead = (id: string) => id === "lead";
const tell = (to: string, atMs = 1000, from = "lead"): PeerMessage => ({ kind: "tell", fromTabId: from, toTabId: to, atMs });

function probe(over: Partial<StallProbe> = {}): StallProbe {
  return {
    now: 1000 + STALL_MS + 1,
    isActive: () => false,
    lastOutputAt: () => undefined,
    lastInputAt: () => undefined,
    screen: () => ["> "],
    ...over,
  };
}

describe("applyMessage", () => {
  it("un tell del orquestador abre una tarea pendiente", () => {
    const p = applyMessage(new Map(), tell("a"), isLead);
    expect(p.get("a")).toMatchObject({ tabId: "a", fromTabId: "lead", at: 1000, alerted: false });
  });

  it("un tell entre miembros o hacia el orquestador no abre tarea", () => {
    expect(applyMessage(new Map(), tell("b", 1000, "a"), isLead).size).toBe(0);
    expect(applyMessage(new Map(), tell("lead", 1000, "a"), isLead).size).toBe(0);
  });

  it("un ask no abre tarea (el ask ya espera solo)", () => {
    const ask: PeerMessage = { kind: "ask", fromTabId: "lead", toTabId: null, atMs: 1 };
    expect(applyMessage(new Map(), ask, isLead).size).toBe(0);
  });

  it("cualquier mensaje DEL agente cierra su tarea", () => {
    const open = applyMessage(new Map(), tell("a"), isLead);
    expect(applyMessage(open, tell("lead", 2000, "a"), isLead).has("a")).toBe(false);
    const ask: PeerMessage = { kind: "ask", fromTabId: "a", toTabId: null, atMs: 2000 };
    expect(applyMessage(open, ask, isLead).has("a")).toBe(false);
  });

  it("una tarea nueva reinicia el reloj y el aviso", () => {
    const first = markAlerted(applyMessage(new Map(), tell("a", 1000), isLead), [
      { tabId: "a", fromTabId: "lead", sinceTaskMs: 0, quietMs: 0, worked: false, lastLine: "" },
    ]);
    const again = applyMessage(first, tell("a", 9000), isLead);
    expect(again.get("a")).toMatchObject({ at: 9000, alerted: false });
  });

  it("no muta el mapa de entrada", () => {
    const base: PendingTasks = new Map();
    applyMessage(base, tell("a"), isLead);
    expect(base.size).toBe(0);
  });
});

describe("findStalls", () => {
  const pending = applyMessage(new Map(), tell("a"), isLead);

  it("avisa al pasar el plazo sin ninguna salida", () => {
    const [s] = findStalls(pending, probe({ screen: () => ["trabajo", "> "] }));
    expect(s).toMatchObject({ tabId: "a", fromTabId: "lead", worked: false, lastLine: ">" });
    expect(s.quietMs).toBe(STALL_MS + 1);
  });

  it("no avisa antes del plazo", () => {
    expect(findStalls(pending, probe({ now: 1000 + STALL_MS - 1 }))).toEqual([]);
  });

  it("no avisa mientras el agente escribe (pensando)", () => {
    expect(findStalls(pending, probe({ isActive: () => true }))).toEqual([]);
  });

  it("el plazo cuenta desde la última salida, no desde la tarea", () => {
    const last = 1000 + STALL_MS - 10;
    expect(findStalls(pending, probe({ lastOutputAt: () => last }))).toEqual([]);
    const [s] = findStalls(pending, probe({ lastOutputAt: () => last, now: last + STALL_MS }));
    expect(s.worked).toBe(true);
    expect(s.quietMs).toBe(STALL_MS);
  });

  it("la salida pegada a la tarea es eco: no cuenta como que trabajó", () => {
    const [s] = findStalls(pending, probe({ lastOutputAt: () => 1500, now: 1500 + STALL_MS + 1 }));
    expect(s.worked).toBe(false);
  });

  it("no avisa si espera al usuario (aprobación en pantalla)", () => {
    const screen = () => ["Edit file src/a.ts", "Do you want to make this edit?", "❯ 1. Yes", "  2. No"];
    expect(findStalls(pending, probe({ screen }))).toEqual([]);
  });

  it("no avisa si el usuario escribió hace poco en esa terminal", () => {
    expect(findStalls(pending, probe({ lastInputAt: () => 1000 + STALL_MS - 5 }))).toEqual([]);
  });

  it("no repite un aviso ya hecho", () => {
    const [s] = findStalls(pending, probe());
    expect(findStalls(markAlerted(pending, [s]), probe())).toEqual([]);
  });

  it("sin terminal viva avisa igual, con la línea vacía", () => {
    const [s] = findStalls(pending, probe({ screen: () => null }));
    expect(s.lastLine).toBe("");
  });
});

describe("isWaitingForUser", () => {
  it("reconoce diálogos de aprobación y preguntas al usuario", () => {
    expect(isWaitingForUser(["Run command?", "Proceed (y/n)"])).toBe(true);
    expect(isWaitingForUser(["Allow this tool to run?"])).toBe(true);
    expect(isWaitingForUser(["Esperando aprovação do usuário"])).toBe(true);
    expect(isWaitingForUser(["Enter to confirm · Esc to cancel"])).toBe(true);
  });

  it("un prompt vacío o salida normal no es espera", () => {
    expect(isWaitingForUser(["Listo, terminé los cambios.", "", "> "])).toBe(false);
    expect(isWaitingForUser([])).toBe(false);
  });

  it("solo mira el final de la pantalla", () => {
    const old = ["Do you want to proceed?", ...Array.from({ length: 12 }, (_, i) => `linha ${i}`)];
    expect(isWaitingForUser(old)).toBe(false);
  });
});

describe("lastScreenLine / stallMessage", () => {
  it("devuelve la última línea con texto y recorta las largas", () => {
    expect(lastScreenLine(["a", "  b  ", "", "  "])).toBe("b");
    expect(lastScreenLine(["x".repeat(300)], 10)).toBe(`${"x".repeat(9)}…`);
    expect(lastScreenLine([])).toBe("");
  });

  it("el aviso trae nombre, tiempos y última línea", () => {
    const text = stallMessage("Frontend", { tabId: "a", fromTabId: "lead", sinceTaskMs: 300_000, quietMs: 180_000, worked: false, lastLine: "> " });
    expect(text).toContain('"Frontend"');
    expect(text).toContain("5 min 00 s");
    expect(text).toContain("3 min 00 s");
    expect(text).toContain("não escreveu nada");
    expect(text).toContain('Última linha da tela: "> "');
    expect(text).toContain('ags peer check "Frontend"');
  });

  it("distingue quem trabalhou e se calou", () => {
    const text = stallMessage("X", { tabId: "a", fromTabId: "l", sinceTaskMs: 1, quietMs: 1, worked: true, lastLine: "" });
    expect(text).toContain("trabalhou e se calou");
    expect(text).toContain("A tela dele está vazia");
  });
});

describe("tell sin pedido", () => {
  const withText = (text: string) => applyMessage(new Map(), { ...tell("a"), text }, isLead);

  it("un agradecimiento o confirmación corta no abre tarea", () => {
    for (const t of ["Obrigado!", "ok", "Valeu, pode seguir.", "Thanks", "👍", "Entendido."]) {
      expect(withText(t).size, t).toBe(0);
    }
  });

  it("un pedido real sí, aunque empiece con cortesía o sea corto", () => {
    for (const t of ["Faça o ponto 1 da etapa 11", "ok, agora rode os testes e me diga o resultado", "ok?", "Revise o PR"]) {
      expect(withText(t).size, t).toBe(1);
    }
  });

  it("sin texto (evento viejo) se trata como tarea", () => {
    expect(isAck(undefined)).toBe(false);
    expect(applyMessage(new Map(), tell("a"), isLead).size).toBe(1);
  });
});

describe("plazo configurable", () => {
  const pending = applyMessage(new Map(), tell("a"), isLead);

  it("el parámetro del detector cambia cuándo avisa", () => {
    const now = 1000 + 30_000;
    expect(findStalls(pending, probe({ now }))).toEqual([]);
    expect(findStalls(pending, probe({ now }), 20_000)).toHaveLength(1);
  });

  it("parseStallMs usa el valor válido o el default de 120 s", () => {
    expect(STALL_MS).toBe(120_000);
    expect(parseStallMs("60000")).toBe(60_000);
    expect(parseStallMs(null)).toBe(STALL_MS);
    expect(parseStallMs("abc")).toBe(STALL_MS);
    expect(parseStallMs(String(MIN_STALL_MS - 1))).toBe(STALL_MS);
  });
});
