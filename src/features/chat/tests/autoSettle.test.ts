import { describe, expect, it } from "vitest";

import {
  autoSettleCandidates,
  autoSettleDays,
  autoSettleDue,
  nextAutoSettleAt,
  parseAutoSettleChoice,
  type AutoSettleCandidate,
} from "../sidebar/autoSettle";

const DAY = 86_400_000;
const NOW = 100 * DAY;
/** `lastUserAt` fica em segundos, como a barra guarda. */
const seconds = (ms: number) => ms / 1000;
const cand = (tabId: string, over: Partial<AutoSettleCandidate> = {}): AutoSettleCandidate => ({
  tabId, pinned: false, busy: false, selected: false, ...over,
});

describe("a escolha de concluir sozinho", () => {
  it("desligado não tem prazo; os outros valores são os dias", () => {
    expect(autoSettleDays("off")).toBeNull();
    expect(autoSettleDays("7")).toBe(7);
    expect(autoSettleDays("30")).toBe(30);
  });

  it("lixo gravado vale desligado", () => {
    expect(parseAutoSettleChoice("14")).toBe("14");
    expect(parseAutoSettleChoice("9999")).toBe("off");
    expect(parseAutoSettleChoice(null)).toBe("off");
  });
});

describe("quais conversas entram na conta", () => {
  const threadOf = (tabId: string) => (tabId.startsWith("thread:") ? tabId.slice(7) : null);

  it("só conversas estruturadas (com thread) são candidatas; as já concluídas saem", () => {
    const out = autoSettleCandidates({
      tabIds: ["thread:t1", "terminal-2", "thread:t3"],
      busy: [], pinned: [], selectedId: null,
      settledThreadIds: new Set(["t3"]), threadOf,
    });
    expect(out.map((c) => c.tabId)).toEqual(["thread:t1"]);
  });

  it("marca fixada, ocupada e a aberta agora", () => {
    const out = autoSettleCandidates({
      tabIds: ["thread:a", "thread:b", "thread:c"],
      busy: ["thread:b"], pinned: ["thread:a"], selectedId: "thread:c",
      settledThreadIds: new Set(), threadOf,
    });
    expect(out).toEqual([
      { tabId: "thread:a", pinned: true, busy: false, selected: false },
      { tabId: "thread:b", pinned: false, busy: true, selected: false },
      { tabId: "thread:c", pinned: false, busy: false, selected: true },
    ]);
  });
});

describe("quando a conversa vence", () => {
  it("vence quando o último pedido seu é mais velho que o prazo", () => {
    const due = autoSettleDue({
      now: NOW, days: 7,
      candidates: [cand("velha"), cand("nova")],
      lastUserAt: { velha: seconds(NOW - 8 * DAY), nova: seconds(NOW - 2 * DAY) },
    });
    expect(due).toEqual(["velha"]);
  });

  it("fixada, ocupada ou aberta nunca vence", () => {
    const lastUserAt = { p: seconds(NOW - 30 * DAY), b: seconds(NOW - 30 * DAY), s: seconds(NOW - 30 * DAY) };
    const due = autoSettleDue({
      now: NOW, days: 7,
      candidates: [cand("p", { pinned: true }), cand("b", { busy: true }), cand("s", { selected: true })],
      lastUserAt,
    });
    expect(due).toEqual([]);
  });

  it("sem data de último pedido, nada conclui (não se chuta)", () => {
    expect(autoSettleDue({ now: NOW, days: 3, candidates: [cand("x")], lastUserAt: {} })).toEqual([]);
  });

  it("o próximo prazo é o da conversa elegível que vence primeiro", () => {
    const next = nextAutoSettleAt({
      now: NOW, days: 7,
      candidates: [cand("a"), cand("b"), cand("fixa", { pinned: true })],
      lastUserAt: { a: seconds(NOW - 2 * DAY), b: seconds(NOW - 5 * DAY), fixa: seconds(NOW - 50 * DAY) },
    });
    expect(next).toBe(NOW - 5 * DAY + 7 * DAY);
  });

  it("sem candidata com data, não há próximo prazo", () => {
    expect(nextAutoSettleAt({ now: NOW, days: 7, candidates: [cand("a")], lastUserAt: {} })).toBeNull();
  });
});
