import { describe, expect, it } from "vitest";

import { barWidth } from "../BudgetBar";
import {
  levelOf,
  nearLimit,
  needsBudgetConfirm,
  type BudgetStatus,
} from "../budgetTypes";

describe("Guarda de Orçamento - QA Edge Cases Suite", () => {
  describe("Faixas de consumo e transições críticas (0%, 79.9%, 80%, 100%)", () => {
    const budget = 10.0;

    it("0.0%: gasto zerado deve ser 'ok' sem avisos ou confirmações", () => {
      const level = levelOf(0, budget);
      expect(level).toBe("ok");
      expect(barWidth({ pct: 0 })).toBe(0);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("79.9%: logo abaixo do teto de aviso deve permanecer 'ok' estritamente", () => {
      const level = levelOf(7.99, budget);
      expect(level).toBe("ok");
      expect(barWidth({ pct: 79.9 })).toBe(79.9);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("80.0%: limite exato deve transicionar para 'warning', mas NÃO bloquear ações", () => {
      const level = levelOf(8.0, budget);
      expect(level).toBe("warning");
      expect(barWidth({ pct: 80 })).toBe(80);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("99.99%: próximo ao estouro continua 'warning' sem bloqueio antecipado", () => {
      expect(levelOf(9.999, budget)).toBe("warning");
      expect(needsBudgetConfirm({ level: "warning", continueAnyway: false })).toBe(false);
    });

    it("100.0%: teto exato deve ser 'exceeded' e BLOQUEAR ações sem continueAnyway", () => {
      const level = levelOf(10.0, budget);
      expect(level).toBe("exceeded");
      expect(barWidth({ pct: 100 })).toBe(100);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(true);
    });

    it(">100% (ex: 150%, 250%): excesso mantém 'exceeded' e barra é clamped em 100%", () => {
      const level = levelOf(15.0, budget);
      expect(level).toBe("exceeded");
      expect(barWidth({ pct: 150 })).toBe(100);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(true);
    });
  });

  describe("Casos de borda: budget nulo e budget 0 / negativo", () => {
    it("budget nulo (null = sem teto definido): nível é sempre 'ok', sem barra nem bloqueio", () => {
      const level = levelOf(54.32, null);
      expect(level).toBe("ok");
      expect(barWidth({ pct: null })).toBe(0);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("budget 0 (teto zero): teto anormal impede gasto e conta imediatamente como 'exceeded'", () => {
      expect(levelOf(0, 0)).toBe("exceeded");
      expect(levelOf(0.01, 0)).toBe("exceeded");
      expect(needsBudgetConfirm({ level: levelOf(0, 0), continueAnyway: false })).toBe(true);
    });

    it("budget negativo: valor inconsistente deve ser tratado com segurança como 'exceeded'", () => {
      expect(levelOf(5, -1.0)).toBe("exceeded");
      expect(levelOf(0, -10.0)).toBe("exceeded");
      expect(needsBudgetConfirm({ level: levelOf(0, -1.0), continueAnyway: false })).toBe(true);
    });
  });

  describe("Modelos sem preço e agentes não medidos (integridade de custo)", () => {
    it("não inventa preço para modelo desconhecido e preserva lista de unpricedModels", () => {
      const status: BudgetStatus = {
        missionId: "mission-test-1",
        level: levelOf(8.5, 10),
        budgetUsd: 10.0,
        costUsd: 8.5,
        pct: 85.0,
        unpricedModels: ["internal-synthetic-preview", "future-claude-7"],
        unmeasuredAgents: ["gemini-qa"],
        continueAnyway: false,
        trendUsdPerHour: 1.25,
      };
      expect(status.level).toBe("warning");
      expect(status.unpricedModels).toContain("internal-synthetic-preview");
      expect(status.unmeasuredAgents).toContain("gemini-qa");
    });
  });

  describe("Liberação de ações mediante consentimento (continueAnyway)", () => {
    it("com continueAnyway = true, ações críticas (recruit, startTask) são liberadas mesmo excedido", () => {
      expect(needsBudgetConfirm({ level: "exceeded", continueAnyway: true })).toBe(false);
    });

    it("com continueAnyway = false e exceeded, exige confirmação", () => {
      expect(needsBudgetConfirm({ level: "exceeded", continueAnyway: false })).toBe(true);
    });
  });

  describe("Janelas de Plano / Quota e nearLimit (80%)", () => {
    it("nearLimit ativa em >= 80% e desativa em < 80% ou null", () => {
      expect(nearLimit({ label: "5h", usedPct: 79.9, resetsAt: "2026-10-06T20:00:00Z" })).toBe(false);
      expect(nearLimit({ label: "5h", usedPct: 80.0, resetsAt: "2026-10-06T20:00:00Z" })).toBe(true);
      expect(nearLimit({ label: "weekly", usedPct: 95.0, resetsAt: null })).toBe(true);
      expect(nearLimit({ label: "5h", usedPct: null, resetsAt: null })).toBe(false);
    });
  });
});
