import { describe, expect, it } from "vitest";

import {
  LEAD_STALL_MS,
  MIN_LEAD_STALL_MS,
  SCREEN_QUESTION_QUIET_MS,
  addAsks,
  applyLeadMessage,
  findLeadStalls,
  findScreenAsks,
  isRequestToLead,
  leadStallMessage,
  leadStallSpan,
  markLeadAlerted,
  parseLeadStallMs,
  screenQuestion,
  type LeadStallProbe,
  type PendingAsks,
} from "../leadStall";
import type { PeerMessage } from "../stalled";

const isLead = (id: string) => id === "lead";
const ask = (from: string, atMs = 1000, toTabId: string | null = null): PeerMessage => ({ kind: "ask", fromTabId: from, toTabId, atMs });
const tell = (from: string, to: string, text: string, atMs = 1000): PeerMessage => ({ kind: "tell", fromTabId: from, toTabId: to, text, atMs });

function probe(over: Partial<LeadStallProbe> = {}): LeadStallProbe {
  return {
    now: 1000 + LEAD_STALL_MS + 1,
    isWorking: () => false,
    isActive: () => false,
    lastOutputAt: () => undefined,
    lastInputAt: () => undefined,
    screen: () => ["> "],
    ...over,
  };
}

const open = (from = "a", at = 1000): PendingAsks => applyLeadMessage(new Map(), ask(from, at), isLead, "lead").pending;

describe("parseLeadStallMs", () => {
  it("vacío, inválido o menor que el mínimo → por defecto", () => {
    expect(parseLeadStallMs(null)).toBe(LEAD_STALL_MS);
    expect(parseLeadStallMs("abc")).toBe(LEAD_STALL_MS);
    expect(parseLeadStallMs(String(MIN_LEAD_STALL_MS - 1))).toBe(LEAD_STALL_MS);
  });
  it("respeta un plazo válido", () => {
    expect(parseLeadStallMs(String(MIN_LEAD_STALL_MS))).toBe(MIN_LEAD_STALL_MS);
  });
});

describe("isRequestToLead", () => {
  it("un ask siempre es un pedido", () => {
    expect(isRequestToLead(ask("a"))).toBe(true);
  });
  it("un tell solo si pregunta y no es cortesía", () => {
    expect(isRequestToLead(tell("a", "lead", "Qual ponto devo assumir?"))).toBe(true);
    expect(isRequestToLead(tell("a", "lead", "Entrega final: tudo pronto, 12 testes ok."))).toBe(false);
    expect(isRequestToLead(tell("a", "lead", "ok, obrigado"))).toBe(false);
    expect(isRequestToLead(tell("a", "lead", "valeu!"))).toBe(false);
  });
});

describe("applyLeadMessage", () => {
  it("un ask de un integrante abre un pedido para el orquestador", () => {
    expect(open().get("a")).toMatchObject({ memberTabId: "a", leadTabId: "lead", at: 1000, source: "peer_ask", alerted: false });
  });

  it("un tell-pregunta al orquestador abre un pedido; una entrega o un 'ok' no", () => {
    const q = applyLeadMessage(new Map(), tell("a", "lead", "Posso editar o terminals.ts?"), isLead, "lead").pending;
    expect(q.get("a")?.source).toBe("peer_tell");
    expect(applyLeadMessage(new Map(), tell("a", "lead", "Concluído."), isLead, "lead").pending.size).toBe(0);
    expect(applyLeadMessage(new Map(), tell("a", "lead", "ok"), isLead, "lead").pending.size).toBe(0);
  });

  it("un tell entre integrantes no abre pedido", () => {
    expect(applyLeadMessage(new Map(), tell("a", "b", "E você, já terminou?"), isLead, "lead").pending.size).toBe(0);
  });

  it("sin orquestador conocido, un ask no abre pedido", () => {
    expect(applyLeadMessage(new Map(), ask("a"), isLead, null).pending.size).toBe(0);
  });

  it("un mensaje del orquestador al integrante cierra el pedido y lo devuelve como respondido", () => {
    const r = applyLeadMessage(open(), tell("lead", "a", "Assuma o ponto 1", 5000), isLead, "lead");
    expect(r.pending.has("a")).toBe(false);
    expect(r.answered).toHaveLength(1);
    expect(r.answered[0]).toMatchObject({ memberTabId: "a", at: 1000, answeredAt: 5000 });
  });

  it("un mensaje del orquestador a otro integrante no cierra el pedido de a", () => {
    const r = applyLeadMessage(open(), tell("lead", "b", "Assuma o ponto 2"), isLead, "lead");
    expect(r.pending.has("a")).toBe(true);
    expect(r.answered).toHaveLength(0);
  });

  it("un pedido nuevo reinicia el reloj y el aviso", () => {
    const alerted = markLeadAlerted(open("a", 1000), [{ memberTabId: "a", leadTabId: "lead", source: "peer_ask", waitedMs: 0, quietMs: 0, question: "" }]);
    expect(alerted.get("a")?.alerted).toBe(true);
    const again = applyLeadMessage(alerted, ask("a", 9000), isLead, "lead").pending;
    expect(again.get("a")).toMatchObject({ at: 9000, alerted: false });
  });

  it("no muta el mapa recibido", () => {
    const before = open();
    applyLeadMessage(before, tell("lead", "a", "ok"), isLead, "lead");
    expect(before.has("a")).toBe(true);
  });
});

describe("findLeadStalls", () => {
  it("avisa cuando el orquestador lleva callado más que el plazo", () => {
    const [stall] = findLeadStalls(open(), probe());
    expect(stall).toMatchObject({ memberTabId: "a", leadTabId: "lead", source: "peer_ask", waitedMs: LEAD_STALL_MS + 1 });
  });

  it("no avisa antes del plazo", () => {
    expect(findLeadStalls(open(), probe({ now: 1000 + LEAD_STALL_MS - 1 }))).toEqual([]);
  });

  it("no avisa si el orquestador escribe ahora (activo o trabajo sostenido)", () => {
    expect(findLeadStalls(open(), probe({ isActive: (id) => id === "lead" }))).toEqual([]);
    expect(findLeadStalls(open(), probe({ isWorking: (id) => id === "lead" }))).toEqual([]);
  });

  it("la salida reciente del orquestador reinicia el reloj de silencio", () => {
    const now = 1000 + LEAD_STALL_MS + 1;
    expect(findLeadStalls(open(), probe({ lastOutputAt: (id) => (id === "lead" ? now - 1000 : undefined) }))).toEqual([]);
    // pasado el plazo desde esa salida, sí avisa
    const stalls = findLeadStalls(open(), probe({ now: now + LEAD_STALL_MS, lastOutputAt: (id) => (id === "lead" ? now - 1000 : undefined) }));
    expect(stalls).toHaveLength(1);
    expect(stalls[0].quietMs).toBeGreaterThanOrEqual(LEAD_STALL_MS);
  });

  it("no avisa si el usuario escribió hace poco en la terminal del orquestador", () => {
    const now = 1000 + LEAD_STALL_MS + 1;
    expect(findLeadStalls(open(), probe({ lastInputAt: (id) => (id === "lead" ? now - 500 : undefined) }))).toEqual([]);
  });

  it("no avisa si el orquestador espera una aprobación del usuario", () => {
    expect(findLeadStalls(open(), probe({ screen: (id) => (id === "lead" ? ["Do you want to proceed?", "❯ 1. Yes", "  2. No"] : ["> "]) }))).toEqual([]);
  });

  it("no repite un pedido ya avisado", () => {
    const stalls = findLeadStalls(open(), probe());
    expect(findLeadStalls(markLeadAlerted(open(), stalls), probe())).toEqual([]);
  });

  it("incluye la pregunta de la pantalla del integrante", () => {
    const [stall] = findLeadStalls(open(), probe({ screen: (id) => (id === "a" ? ["Trabalho feito.", "Devo seguir com o ponto 2?", "> "] : ["> "]) }));
    expect(stall.question).toBe("Devo seguir com o ponto 2?");
  });

  it("varios integrantes esperando generan un aviso por cada uno", () => {
    const two = applyLeadMessage(open("a"), ask("b", 1100), isLead, "lead").pending;
    expect(findLeadStalls(two, probe({ now: 1100 + LEAD_STALL_MS + 1 })).map((s) => s.memberTabId).sort()).toEqual(["a", "b"]);
  });
});

describe("screenQuestion", () => {
  it("reconoce una pregunta al final de la pantalla", () => {
    expect(screenQuestion(["Li o arquivo.", "Qual ponto devo assumir agora?", "", "> "])).toBe("Qual ponto devo assumir agora?");
  });
  it("ignora el prompt de entrada y la ayuda de la TUI", () => {
    expect(screenQuestion(["Pronto.", "> o que você acha?"])).toBeNull();
    expect(screenQuestion(["Pronto.", "? for shortcuts"])).toBeNull();
  });
  it("un diálogo de aprobación espera al usuario, no al orquestador", () => {
    expect(screenQuestion(["Do you want to proceed?", "❯ 1. Yes", "  2. No"])).toBeNull();
  });
  it("sin pregunta (o pantalla vacía) → null", () => {
    expect(screenQuestion(["Tudo certo.", "Testes passaram."])).toBeNull();
    expect(screenQuestion([])).toBeNull();
  });
  it("una pregunta antigua fuera de las últimas líneas no cuenta", () => {
    const lines = ["Posso seguir?", ...Array.from({ length: 8 }, (_, i) => `linha ${i}`)];
    expect(screenQuestion(lines)).toBeNull();
  });
});

describe("findScreenAsks", () => {
  const members = new Map([["a", "lead"]]);
  const quietProbe = (over: Partial<LeadStallProbe> = {}) =>
    probe({ now: 100_000, lastOutputAt: () => 100_000 - SCREEN_QUESTION_QUIET_MS, screen: () => ["Posso editar o arquivo X?", "> "], ...over });

  it("un integrante quieto con una pregunta en pantalla abre un pedido de origen 'screen'", () => {
    const [found] = findScreenAsks(members, new Map(), quietProbe());
    expect(found).toMatchObject({ memberTabId: "a", leadTabId: "lead", source: "screen", at: 100_000 - SCREEN_QUESTION_QUIET_MS });
  });
  it("no si escribió hace poco, está activo o ya hay un pedido abierto", () => {
    expect(findScreenAsks(members, new Map(), quietProbe({ lastOutputAt: () => 99_000 }))).toEqual([]);
    expect(findScreenAsks(members, new Map(), quietProbe({ isActive: () => true }))).toEqual([]);
    expect(findScreenAsks(members, open(), quietProbe())).toEqual([]);
  });
  it("no si nunca escribió (sin salida conocida) o no hay pregunta", () => {
    expect(findScreenAsks(members, new Map(), quietProbe({ lastOutputAt: () => undefined }))).toEqual([]);
    expect(findScreenAsks(members, new Map(), quietProbe({ screen: () => ["Tudo certo.", "> "] }))).toEqual([]);
  });
  it("addAsks no pisa un pedido existente", () => {
    const base = open("a", 1000);
    const merged = addAsks(base, [{ memberTabId: "a", leadTabId: "lead", at: 5000, source: "screen", alerted: false }]);
    expect(merged.get("a")?.at).toBe(1000);
  });
});

describe("leadStallMessage / leadStallSpan", () => {
  const stall = { memberTabId: "a", leadTabId: "lead", source: "peer_ask" as const, waitedMs: 200_000, quietMs: 200_000, question: "" };
  it("el aviso nombra al integrante, la espera y cómo contestar", () => {
    const text = leadStallMessage("Backend", stall);
    expect(text).toContain("Backend");
    expect(text).toContain("3 min 20 s");
    expect(text).toContain('ags peer tell "Backend"');
  });
  it("incluye la pregunta cuando viene de la pantalla", () => {
    expect(leadStallMessage("QA", { ...stall, source: "screen", question: "Posso seguir?" })).toContain('Pergunta: "Posso seguir?"');
  });
  it("el span lleva el desenlace y la fuente, y nunca termina antes de empezar", () => {
    expect(leadStallSpan({ at: 1000, source: "peer_ask" }, 4000, "alerted", "Backend", "Orquestrador")).toEqual({
      kind: "orchestrator_stall", actor: "Backend", target: "Orquestrador", startedMs: 1000, endedMs: 4000, detail: "alerted:peer_ask",
    });
    expect(leadStallSpan({ at: 5000, source: "screen" }, 1000, "answered", "a", "b").endedMs).toBe(5000);
  });
});
