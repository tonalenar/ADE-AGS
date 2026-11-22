import { describe, expect, it } from "vitest";

import { limitPercentFor, shouldShowRailLimit, summarizeOtherAccounts, type UsageSnapshot } from "@/features/chat/pickerLimits";
import type { RailItem } from "@/features/chat/pickerRail";
import type { AccountEntry, AccountReading } from "@/features/chat/summary/limitsModel";

const NOW = 1_700_000_000;
const item = (over: Partial<RailItem>): RailItem => ({
  key: "k", agentId: "claude-code", accountId: null, name: "n", badgeLabel: "N", accentColor: null, showBadge: true, loggedIn: true, ...over,
});
const live = (session: number | null, week: number | null) => ({
  available: true, session: session === null ? null : { percent: session, resets: null }, week: week === null ? null : { percent: week, resets: null },
  weekModels: [], fetchedAt: NOW, cached: false, problem: null,
});
const empty: UsageSnapshot = { claude: {}, codex: {}, antigravity: {}, agy: { usage: null, failed: false } };

describe("limite de cada conta no trilho do seletor", () => {
  it("Claude: usa a chave da conta (id, ou system:<agente> na principal) e mostra a janela mais gasta", () => {
    const snap: UsageSnapshot = { ...empty, claude: { "system:claude-code": live(42, 17), a1: live(10, 88) } };
    expect(limitPercentFor(item({ accountId: null }), snap, NOW)).toBe(42);
    expect(limitPercentFor(item({ accountId: "a1" }), snap, NOW)).toBe(88);
  });

  it("sem leitura ainda, sem login ou com falha: não há número (nunca se inventa)", () => {
    expect(limitPercentFor(item({ accountId: "a1" }), empty, NOW)).toBeNull();
    expect(limitPercentFor(item({ accountId: "a1", loggedIn: false }), { ...empty, claude: { a1: live(50, 50) } }, NOW)).toBeNull();
    expect(limitPercentFor(item({ accountId: "a1" }), { ...empty, claude: { a1: { ...live(50, 50), available: false } } }, NOW)).toBeNull();
  });

  it("Codex: janela de 5 h e de 7 dias, e o servidor recusando vale 100", () => {
    const codex = (fiveHour: number, rejected = false) => ({
      usage: { email: null, plan: null, auth: "chatgpt", fetchedAt: NOW, quota: { fiveHour: { utilization: fiveHour, resetsAt: NOW + 3600 }, sevenDay: null, rejected, rejectedUntil: null, overage: false } },
      failed: false,
    });
    expect(limitPercentFor(item({ agentId: "codex", accountId: "c1" }), { ...empty, codex: { c1: codex(0.9) } }, NOW)).toBe(90);
    expect(limitPercentFor(item({ agentId: "codex", accountId: "c1" }), { ...empty, codex: { c1: codex(0.3, true) } }, NOW)).toBe(100);
  });

  it("uma janela que já renovou não mostra o número velho", () => {
    const old = { usage: { email: null, plan: null, auth: "chatgpt", fetchedAt: NOW, quota: { fiveHour: { utilization: 0.9, resetsAt: NOW - 10 }, sevenDay: null, rejected: false, rejectedUntil: null, overage: false } }, failed: false };
    expect(limitPercentFor(item({ agentId: "codex", accountId: "c1" }), { ...empty, codex: { c1: old } }, NOW)).toBeNull();
  });

  it("Antigravity: a principal lê o agy local; a de perfil lê os grupos do agy ou os medidores por modelo", () => {
    const agy = { usage: { installed: true, fetchedAt: NOW, cached: false, groups: [{ name: "g", windows: [{ id: "w", kind: "session" as const, usedPct: 33, resetsAt: new Date((NOW + 3600) * 1000).toISOString() }] }] }, failed: false };
    expect(limitPercentFor(item({ agentId: "antigravity", accountId: null }), { ...empty, agy }, NOW)).toBe(33);
    const meters = { g1: { meters: [{ name: "m", percent: 71, resetsAt: NOW + 3600 }], failed: false, fetchedAt: NOW } };
    expect(limitPercentFor(item({ agentId: "antigravity", accountId: "g1" }), { ...empty, antigravity: meters as never }, NOW)).toBe(71);
    const cliExtra = {
      kiro0: {
        meters: null,
        groups: [{ name: "Gemini Models", windows: [{ id: "w", kind: "weekly" as const, usedPct: 48, resetsAt: new Date((NOW + 3600) * 1000).toISOString() }] }],
        failed: false,
        fetchedAt: NOW,
      },
    };
    expect(limitPercentFor(item({ agentId: "antigravity", accountId: "kiro0" }), { ...empty, agy, antigravity: cliExtra as never }, NOW)).toBe(48);
  });

  it("agente sem fonte de cota não tem número", () => {
    expect(limitPercentFor(item({ agentId: "gemini-cli" }), empty, NOW)).toBeNull();
  });
});

describe("quando a barra aparece", () => {
  it("só nos agentes com mais de um ícone no trilho, e só com um número", () => {
    const a = item({ key: "a", agentId: "claude-code" });
    const b = item({ key: "b", agentId: "claude-code", accountId: "x" });
    const c = item({ key: "c", agentId: "codex" });
    expect(shouldShowRailLimit(a, [a, b, c], 40)).toBe(true);
    expect(shouldShowRailLimit(a, [a, b, c], null)).toBe(false);
    expect(shouldShowRailLimit(c, [a, b, c], 40)).toBe(false);
  });
});

describe("resumo de Outras contas no painel Limites de uso", () => {
  const entry = (key: string, agentId = "claude-code"): AccountEntry => ({
    key, agentId, accountId: key, account: null, who: [],
  });
  const measured = (percent: number, rejected = false): AccountReading => ({
    state: "measured",
    windows: [{ kind: "session", label: null, percent, resetsAt: null, resetsText: null, expired: false }],
    rejected,
  });

  it("conta quantas contas passaram de 80% e distingue aviso âmbar de esgotado", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const map: Record<string, AccountReading> = {
      a: measured(40),
      b: measured(80), // exatamente 80% não passa de 80
      c: measured(85),
    };
    const s1 = summarizeOtherAccounts(entries, (e) => map[e.key]!);
    expect(s1.count).toBe(3);
    expect(s1.highUsageCount).toBe(1);
    expect(s1.warningLevel).toBe("warn");

    map.a = measured(100);
    const s2 = summarizeOtherAccounts(entries, (e) => map[e.key]!);
    expect(s2.highUsageCount).toBe(2);
    expect(s2.warningLevel).toBe("full");
  });

  it("sem contas acima de 80%, não emite aviso", () => {
    const entries = [entry("a"), entry("b")];
    const s = summarizeOtherAccounts(entries, () => ({ state: "unmeasured", reason: "noQuotaSource" }));
    expect(s.count).toBe(2);
    expect(s.highUsageCount).toBe(0);
    expect(s.warningLevel).toBeNull();
  });
});
