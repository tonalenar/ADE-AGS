import { describe, expect, it } from "vitest";

import { pendingSend, unreconciled, PENDING_TTL_MS } from "../timeline/pending";
import type { TimelineItem } from "../timeline/types";

const user = (id: string, text: string): TimelineItem => ({ kind: "user", id, text });

describe("unreconciled", () => {
  it("mantém o envio até a mensagem real chegar, sem duplicar", () => {
    const p = pendingSend("p1", "rode os testes", [], 1000);
    expect(unreconciled([p], [], 1500)).toEqual([p]);
    expect(unreconciled([p], [user("u1", "rode os testes")], 1500)).toEqual([]);
  });

  it("ignora espaços e quebras ao comparar", () => {
    const p = pendingSend("p1", "oi  \n tudo bem", [], 1000);
    expect(unreconciled([p], [user("u1", "oi tudo bem")], 1500)).toEqual([]);
  });

  it("uma mensagem igual de antes não conta como o eco", () => {
    const before = [user("u0", "ok")];
    const p = pendingSend("p1", "ok", before, 1000);
    expect(unreconciled([p], before, 1500)).toEqual([p]);
    expect(unreconciled([p], [...before, user("u1", "ok")], 1500)).toEqual([]);
  });

  it("dois envios iguais esperam cada um o seu eco", () => {
    const a = pendingSend("a", "sim", [], 1000);
    const b = pendingSend("b", "sim", [], 1001);
    expect(unreconciled([a, b], [user("u1", "sim")], 1500)).toEqual([b]);
    expect(unreconciled([a, b], [user("u1", "sim"), user("u2", "sim")], 1500)).toEqual([]);
  });

  it("o envio sem eco some depois do prazo, sem relógio de verdade", () => {
    const p = pendingSend("p1", "/compact", [], 1000);
    expect(unreconciled([p], [], 1000 + PENDING_TTL_MS)).toEqual([p]);
    expect(unreconciled([p], [], 1001 + PENDING_TTL_MS)).toEqual([]);
  });
});

describe("unreconciled: mensagem na fila do agente", () => {
  it("enquanto o agente trabalha, o envio sem eco não some pelo prazo (a mensagem espera a vez dela)", () => {
    const p = pendingSend("p1", "e o lint?", [], 1000);
    expect(unreconciled([p], [], 1001 + PENDING_TTL_MS, true)).toEqual([p]);
    expect(unreconciled([p], [], 1001 + PENDING_TTL_MS, false)).toEqual([]);
  });

  it("a mensagem descartada da fila (aviso 'não enviada') é o desfecho dela: o envio otimista sai", () => {
    const p = pendingSend("p1", "e o lint?", [], 1000);
    const dropped: TimelineItem = { kind: "notice", id: "n1", label: "queueDropped", text: "e o lint?" };
    expect(unreconciled([p], [dropped], 1500, true)).toEqual([]);
    const other: TimelineItem = { kind: "notice", id: "n2", label: "resumeLost", text: "e o lint?" };
    expect(unreconciled([p], [other], 1500, true)).toEqual([p]);
  });
});
