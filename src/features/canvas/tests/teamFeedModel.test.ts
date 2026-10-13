import { describe, expect, it } from "vitest";

import { buildFeed, isVigiaMessage, mergeMessages, parseMention, resolveMention, suggestMentions, type TeamMessage } from "../teamFeedModel";

const team = [
  { id: "t1", name: "Orquestrador" },
  { id: "t2", name: "Backend" },
  { id: "t3", name: "Frontend" },
  { id: "t4", name: "QA / Tests" },
];

describe("parseMention", () => {
  it("manda ao agente do @ e tira o @Nome do texto", () => {
    expect(parseMention("@Backend rode os testes", team)).toEqual({ to: team[1], text: "rode os testes" });
    expect(parseMention("  @backend   oi", team)).toEqual({ to: team[1], text: "oi" });
  });
  it("aceita o nome inteiro com espaços ou só a primeira palavra", () => {
    expect(parseMention("@QA / Tests confira", team)?.to.id).toBe("t4");
    expect(parseMention("@QA confira", team)?.to.id).toBe("t4");
  });
  it("não casa nome parcial, sem texto ou @ no meio", () => {
    expect(parseMention("@Back rode", team)).toBeNull();
    expect(parseMention("@Backend", team)).toBeNull();
    expect(parseMention("oi @Backend", team)).toBeNull();
    expect(parseMention("sem menção", team)).toBeNull();
  });
});

describe("suggestMentions", () => {
  it("filtra os nomes enquanto a palavra do @ não acabou", () => {
    expect(suggestMentions("@", team).map((a) => a.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(suggestMentions("@f", team).map((a) => a.id)).toEqual(["t3"]);
    expect(suggestMentions("@qa", team).map((a) => a.id)).toEqual(["t4"]);
    expect(suggestMentions("@Backend oi", team)).toEqual([]);
    expect(suggestMentions("oi", team)).toEqual([]);
  });
});

describe("buildFeed", () => {
  const message = (id: number, atMs: number): TeamMessage => ({ id, missionId: "m", atMs, kind: "tell", fromTabId: "t1", fromName: "Orquestrador", toTabId: "t2", toName: "Backend", text: `m${id}` });
  it("ordena mensagens, pedidos de permissão e o que você mandou por hora; segundos viram ms", () => {
    const approval = { id: "a1", taskId: "k", toolName: "Bash", input: {}, askedAt: 1500, suggestedRule: null };
    const feed = buildFeed([message(2, 3_000_000), message(1, 1_000_000)], [{ approval, who: "Tarefa" }], [{ key: "u1", atMs: 2_000_000, toName: "Backend", text: "oi" }]);
    expect(feed.map((i) => i.key)).toEqual(["m1", "aa1", "u1", "m2"]);
    expect(feed[1].atMs).toBe(1_500_000);
  });
});

describe("resolveMention", () => {
  it("@Nome sem texto pede o texto, não diz que o agente não existe", () => {
    expect(resolveMention("@Backend", team)).toEqual({ kind: "empty", to: team[1] });
    expect(resolveMention("@Backend,  ", team)).toEqual({ kind: "empty", to: team[1] });
  });
  it("vírgula, dois-pontos e ponto e vírgula depois do nome valem", () => {
    expect(resolveMention("@Backend, rode os testes", team)).toEqual({ kind: "ok", to: team[1], text: "rode os testes" });
    expect(resolveMention("@QA: confira", team)).toEqual({ kind: "ok", to: team[3], text: "confira" });
    expect(resolveMention("@QA / Tests; confira", team)).toEqual({ kind: "ok", to: team[3], text: "confira" });
    expect(resolveMention("@Backendx oi", team)).toEqual({ kind: "unknown" });
  });
  it("sem @ é none; @ desconhecido é unknown", () => {
    expect(resolveMention("oi @Backend", team)).toEqual({ kind: "none" });
    expect(resolveMention("@Ninguem oi", team)).toEqual({ kind: "unknown" });
  });
  it("mesma primeira palavra é ambíguo; o nome inteiro desempata", () => {
    const two = [{ id: "a", name: "Claude A" }, { id: "b", name: "Claude B" }];
    expect(resolveMention("@Claude oi", two)).toEqual({ kind: "ambiguous", names: ["Claude A", "Claude B"] });
    expect(resolveMention("@Claude B oi", two)).toEqual({ kind: "ok", to: two[1], text: "oi" });
    const same = [{ id: "a", name: "QA" }, { id: "b", name: "QA" }];
    expect(resolveMention("@QA oi", same).kind).toBe("ambiguous");
  });
});

describe("mergeMessages e isVigiaMessage", () => {
  const msg = (id: number, fromName = "Orquestrador"): TeamMessage => ({ id, missionId: "m", atMs: id, kind: "tell", fromTabId: "t1", fromName, toTabId: "t2", toName: "Backend", text: `m${id}` });
  it("não repete id e mantém a lista quando nada é novo", () => {
    const all = [msg(1), msg(2)];
    expect(mergeMessages(all, [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3]);
    expect(mergeMessages(all, [msg(1), msg(2)])).toBe(all);
  });
  it("reconhece o Vigia pelo from_name, sem diferenciar caixa", () => {
    expect(isVigiaMessage(msg(1, "Vigia"))).toBe(true);
    expect(isVigiaMessage(msg(1, " vigia "))).toBe(true);
    expect(isVigiaMessage(msg(1))).toBe(false);
  });
});
