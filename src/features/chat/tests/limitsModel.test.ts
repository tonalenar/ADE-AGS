import { describe, expect, it } from "vitest";

import {
  accountKeyOf, budgetOf, headlineOf, limitLevel, readAntigravity, readClaude, readCodex, renewal, usedAccounts,
  type AccountReading,
} from "../summary/limitsModel";

const NOW = 1_700_000_000;

describe("nível de alerta da barra", () => {
  it("sem número é 'não medido'; até 80% é normal; acima de 80% é âmbar; 100% é esgotado", () => {
    expect(limitLevel(null)).toBe("unknown");
    expect(limitLevel(0)).toBe("ok");
    expect(limitLevel(80)).toBe("ok");
    expect(limitLevel(81)).toBe("warn");
    expect(limitLevel(99)).toBe("warn");
    expect(limitLevel(100)).toBe("full");
    expect(limitLevel(130)).toBe("full");
  });
});

describe("quando a janela renova", () => {
  it("a janela de 5 h mostra quanto falta; passada a hora, diz que já renovou", () => {
    expect(renewal("session", NOW + 2 * 3600 + 14 * 60, NOW)).toEqual({ kind: "in", seconds: 2 * 3600 + 14 * 60 });
    expect(renewal("session", NOW - 1, NOW)).toEqual({ kind: "passed" });
    expect(renewal("session", NOW, NOW)).toEqual({ kind: "passed" });
  });

  it("a semanal mostra o dia e a hora (um instante), não a contagem", () => {
    expect(renewal("week", NOW + 3 * 86400, NOW)).toEqual({ kind: "at", epoch: NOW + 3 * 86400 });
    expect(renewal("week", NOW + 3600, NOW)).toEqual({ kind: "at", epoch: NOW + 3600 });
  });

  it("uma janela de 5 h que só renova daqui a mais de um dia também vira um instante", () => {
    expect(renewal("session", NOW + 30 * 3600, NOW)).toEqual({ kind: "at", epoch: NOW + 30 * 3600 });
  });

  it("sem horário informado, não há renovação a mostrar", () => {
    expect(renewal("session", null, NOW)).toBeNull();
  });
});

describe("Claude Code: a cota vem do /usage da própria TUI", () => {
  const live = (over = {}) => ({ available: true, session: { percent: 42, resets: "3pm (America/Sao_Paulo)" }, week: { percent: 17, resets: "Mon 9am" }, weekModels: [], fetchedAt: NOW, cached: false, problem: null, ...over });

  it("lê a sessão e a semana, com o texto de renovação que a TUI deu", () => {
    const r = readClaude(live(), true, NOW);
    expect(r).toMatchObject({ state: "measured" });
    expect((r as { windows: unknown[] }).windows).toEqual([
      { kind: "session", label: null, percent: 42, resetsAt: null, resetsText: "3pm (America/Sao_Paulo)", expired: false },
      { kind: "week", label: null, percent: 17, resetsAt: null, resetsText: "Mon 9am", expired: false },
    ]);
  });

  it("não inventa: sem leitura ainda é 'carregando'; falha da TUI é 'falhou'; sem login é 'sem login'", () => {
    expect(readClaude(null, true, NOW)).toEqual({ state: "unmeasured", reason: "loading" });
    expect(readClaude(live({ available: false, session: null, week: null, problem: "x" }), true, NOW)).toEqual({ state: "unmeasured", reason: "failed" });
    expect(readClaude(live(), false, NOW)).toEqual({ state: "unmeasured", reason: "notLoggedIn" });
    expect(readClaude(live({ session: null, week: null }), true, NOW)).toEqual({ state: "unmeasured", reason: "noWindows" });
  });

  it("limita a porcentagem a 0–100", () => {
    const r = readClaude(live({ session: { percent: 140, resets: null }, week: { percent: -3, resets: null } }), true, NOW) as { windows: { percent: number }[] };
    expect(r.windows.map((w) => w.percent)).toEqual([100, 0]);
  });
});

describe("Codex: a cota vem de duas janelas com horário", () => {
  const entry = (quota: unknown, over = {}) => ({ usage: { email: null, plan: "plus", auth: "chatgpt", quota, fetchedAt: NOW, ...over }, failed: false });

  it("converte 0–1 em porcentagem e guarda o horário de renovar", () => {
    const r = readCodex(entry({ fiveHour: { utilization: 0.42, resetsAt: NOW + 3600 }, sevenDay: { utilization: 0.9, resetsAt: NOW + 86400 }, rejected: false, rejectedUntil: null, overage: false }) as never, true, NOW);
    expect(r).toMatchObject({ state: "measured", rejected: false });
    expect((r as { windows: { kind: string; percent: number | null; resetsAt: number | null }[] }).windows.map((w) => [w.kind, w.percent, w.resetsAt])).toEqual([["session", 42, NOW + 3600], ["week", 90, NOW + 86400]]);
  });

  it("uma janela que já renovou não mostra a porcentagem velha (não se sabe o novo uso)", () => {
    const r = readCodex(entry({ fiveHour: { utilization: 0.99, resetsAt: NOW - 60 }, sevenDay: null, rejected: false, rejectedUntil: null, overage: false }) as never, true, NOW) as { windows: unknown[] };
    expect(r.windows).toEqual([{ kind: "session", label: null, percent: null, resetsAt: NOW - 60, resetsText: null, expired: true }]);
  });

  it("API key não tem janela de plano; sem janelas informadas é 'sem janelas'; falha sem dado é 'falhou'", () => {
    expect(readCodex(entry(null, { auth: "apiKey" }) as never, true, NOW)).toEqual({ state: "unmeasured", reason: "apiKey" });
    expect(readCodex(entry(null) as never, true, NOW)).toEqual({ state: "unmeasured", reason: "noWindows" });
    expect(readCodex({ usage: null, failed: true }, true, NOW)).toEqual({ state: "unmeasured", reason: "failed" });
    expect(readCodex(undefined, true, NOW)).toEqual({ state: "unmeasured", reason: "loading" });
    expect(readCodex(entry(null) as never, false, NOW)).toEqual({ state: "unmeasured", reason: "notLoggedIn" });
  });

  it("marca quando o servidor recusou por limite (esgotado)", () => {
    const r = readCodex(entry({ fiveHour: { utilization: 1, resetsAt: NOW + 600 }, sevenDay: null, rejected: true, rejectedUntil: NOW + 600, overage: false }) as never, true, NOW);
    expect(r).toMatchObject({ state: "measured", rejected: true });
  });
});

describe("Antigravity: o modelo mais gasto", () => {
  it("mostra só o modelo com mais uso, com o nome", () => {
    const r = readAntigravity({ meters: [{ id: "a", name: "Gemini Pro", percent: 70, resetsAt: NOW + 100 }, { id: "b", name: "Flash", percent: 10, resetsAt: null }], failed: false, fetchedAt: NOW }, true, NOW);
    expect((r as { windows: unknown[] }).windows).toEqual([{ kind: "model", label: "Gemini Pro", percent: 70, resetsAt: NOW + 100, resetsText: null, expired: false }]);
  });
  it("sem medidores é 'sem janelas'", () => {
    expect(readAntigravity({ meters: [], failed: false, fetchedAt: NOW }, true, NOW)).toEqual({ state: "unmeasured", reason: "noWindows" });
    expect(readAntigravity(undefined, true, NOW)).toEqual({ state: "unmeasured", reason: "loading" });
  });
});

describe("orçamento do dia", () => {
  it("só existe com limite configurado", () => {
    expect(budgetOf({ limits: { maxConcurrent: null, dailyBudgetUsd: null }, spent24h: 3 })).toBeNull();
    expect(budgetOf(undefined)).toBeNull();
  });
  it("calcula gasto, teto e porcentagem", () => {
    expect(budgetOf({ limits: { maxConcurrent: null, dailyBudgetUsd: 20 }, spent24h: 5 })).toEqual({ spent: 5, budget: 20, percent: 25 });
    expect(budgetOf({ limits: { maxConcurrent: null, dailyBudgetUsd: 0 }, spent24h: 0 })).toBeNull();
  });
});

describe("o destaque do cartão", () => {
  it("é a janela mais gasta; sem número, nada", () => {
    const measured: AccountReading = { state: "measured", rejected: false, windows: [
      { kind: "session", label: null, percent: 42, resetsAt: null, resetsText: null, expired: false },
      { kind: "week", label: null, percent: 90, resetsAt: null, resetsText: null, expired: false },
    ] };
    expect(headlineOf(measured)).toBe(90);
    expect(headlineOf({ state: "unmeasured", reason: "noSource" })).toBeNull();
    expect(headlineOf({ state: "measured", rejected: false, windows: [{ kind: "session", label: null, percent: null, resetsAt: null, resetsText: null, expired: true }] })).toBeNull();
  });
  it("recusa do servidor vale como esgotado mesmo sem número", () => {
    expect(headlineOf({ state: "measured", rejected: true, windows: [] })).toBe(100);
  });
});

describe("contas usadas pela conversa e pelo time", () => {
  it("a conta principal tem a chave system:<agente>", () => {
    expect(accountKeyOf("claude-code", null)).toBe("system:claude-code");
    expect(accountKeyOf("claude-code", undefined)).toBe("system:claude-code");
    expect(accountKeyOf("codex", "abc")).toBe("abc");
  });

  it("junta integrantes que usam a mesma conta e mantém a ordem de aparição", () => {
    const list = usedAccounts([
      { name: "Claude Code", agentId: "claude-code", accountId: null },
      { name: "Codex · Revisor", agentId: "codex", accountId: "c1" },
      { name: "Claude · UI", agentId: "claude-code", accountId: undefined },
      { name: "Claude · Testes", agentId: "claude-code", accountId: "ton" },
    ]);
    expect(list).toEqual([
      { key: "system:claude-code", agentId: "claude-code", accountId: null, who: ["Claude Code", "Claude · UI"] },
      { key: "c1", agentId: "codex", accountId: "c1", who: ["Codex · Revisor"] },
      { key: "ton", agentId: "claude-code", accountId: "ton", who: ["Claude · Testes"] },
    ]);
  });
});
