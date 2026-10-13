import { describe, expect, it } from "vitest";

import { buildFeed, feedFilterOptions, filterFeed, isContinuation, needsCollapse, parseMention, suggestMentions, type TeamMessage } from "../teamFeedModel";

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

describe("filtros, continuação e texto longo", () => {
  const m = (id: number, from: string, to: string, atMs: number, kind: "tell" | "ask" = "tell"): TeamMessage => ({ id, missionId: "m", atMs, kind, fromTabId: from, fromName: from, toTabId: to, toName: to, text: "x" });
  const feed = buildFeed([m(1, "Orq", "Back", 1000), m(2, "Orq", "Back", 60_000), m(3, "Back", "Orq", 70_000), m(4, "Orq", "Back", 400_000)], [], [{ key: "u", atMs: 80_000, toName: "Back", text: "oi" }]);
  it("lista os nomes que aparecem e filtra por agente", () => {
    expect(feedFilterOptions(feed)).toEqual({ names: ["Orq", "Back"], approvals: 0 });
    expect(filterFeed(feed, "agent:Back").length).toBe(5);
    expect(filterFeed(feed, "approvals")).toEqual([]);
    expect(filterFeed(feed, "all")).toBe(feed);
  });
  it("junta mensagens seguidas do mesmo remetente ao mesmo destino em até 2 minutos", () => {
    expect(isContinuation(feed[0], feed[1])).toBe(true);
    expect(isContinuation(feed[1], feed[2])).toBe(false);
    expect(isContinuation(feed[3], feed[4])).toBe(false);
    expect(isContinuation(undefined, feed[0])).toBe(false);
  });
  it("dobra só texto comprido", () => {
    expect(needsCollapse("curto")).toBe(false);
    expect(needsCollapse("a".repeat(481))).toBe(true);
    expect(needsCollapse("1\n2\n3\n4\n5\n6\n7\n8")).toBe(true);
  });
});
