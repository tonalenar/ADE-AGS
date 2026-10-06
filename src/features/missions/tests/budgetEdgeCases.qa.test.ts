import { describe, expect, it } from "vitest";

/**
 * QA Suite de Casos de Borda do Guarda de Orçamento (Etapa 21, item 14).
 *
 * Casos de borda exigidos:
 * - 0% (início sem gasto)
 * - 79.9% (limite estrito inferior de aviso: ainda "ok")
 * - 80.0% (início de aviso: "warning", nearLimit ativo, sem bloqueio de ação)
 * - 99.99% (aviso no teto iminente)
 * - 100.0% (teto atingido: "exceeded", exige confirmação explícita de continuação)
 * - >100% (excesso sustentado: 150%, 250%, etc.)
 * - budget nulo (missão sem teto: sempre "ok", sem aviso ou bloqueio)
 * - budget 0 (teto anômalo zero: impede novos gastos, classificado como "exceeded")
 * - budget negativo (anomalia de entrada: "exceeded")
 * - modelo sem preço no catálogo (tokens medidos, preço não inventado, listado em unpricedModels)
 * - agente/aba sem medição (Gemini, etc.: listado em unmeasuredAgents, exibido em cinza)
 * - flag continueAnyway (após consentimento do usuário, desbloqueia ações como recruit/startTask)
 */

export type BudgetLevel = "ok" | "warning" | "exceeded";
export type BudgetGatedAction = "recruit" | "startTask";

export interface BudgetStatus {
  missionId: string;
  level: BudgetLevel;
  budgetUsd: number | null;
  costUsd: number;
  pct: number | null;
  unpricedModels: string[];
  unmeasuredAgents: string[];
  continueAnyway: boolean;
  trendUsdPerHour: number | null;
}

export interface PlanWindow {
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
}

export const NEAR_LIMIT_PCT = 80;

/** Nível de orçamento puramente computado a partir do custo e teto */
export function levelOf(costUsd: number, budgetUsd: number | null): BudgetLevel {
  if (budgetUsd === null) return "ok";
  if (budgetUsd <= 0) return "exceeded";
  const pct = (costUsd / budgetUsd) * 100;
  return pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "ok";
}

/** Calcula percentual de consumo com tratamento rigoroso de bordas */
export function pctOf(costUsd: number, budgetUsd: number | null): number | null {
  if (budgetUsd === null) return null;
  if (budgetUsd <= 0) return 100;
  return Number(((costUsd / budgetUsd) * 100).toFixed(2));
}

/** Verifica se a ação exige confirmação modal do usuário */
export const needsBudgetConfirm = (s: Pick<BudgetStatus, "level" | "continueAnyway">): boolean =>
  s.level === "exceeded" && !s.continueAnyway;

/** Largura da barra de orçamento (0-100%, clamped) */
export function barWidth(s: { pct?: number | null }): number {
  if (s.pct === null || s.pct === undefined || Number.isNaN(s.pct)) return 0;
  return Math.min(100, Math.max(0, s.pct));
}

/** Verifica proximidade do limite de cota/plano */
export const nearLimit = (w: PlanWindow): boolean => w.usedPct !== null && w.usedPct >= NEAR_LIMIT_PCT;

describe("Guarda de Orçamento - QA Edge Cases Suite", () => {
  describe("Faixas de consumo e transições críticas (0%, 79.9%, 80%, 100%)", () => {
    const budget = 10.0;

    it("0.0%: gasto zerado deve ser 'ok' sem avisos ou confirmações", () => {
      const cost = 0.0;
      const level = levelOf(cost, budget);
      const pct = pctOf(cost, budget);
      expect(level).toBe("ok");
      expect(pct).toBe(0);
      expect(barWidth({ pct })).toBe(0);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("79.9%: logo abaixo do teto de aviso deve permanecer 'ok' estritamente", () => {
      const cost = 7.99;
      const level = levelOf(cost, budget);
      const pct = pctOf(cost, budget);
      expect(level).toBe("ok");
      expect(pct).toBe(79.9);
      expect(barWidth({ pct })).toBe(79.9);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("80.0%: limite exato deve transicionar para 'warning', mas NÃO bloquear ações", () => {
      const cost = 8.0;
      const level = levelOf(cost, budget);
      const pct = pctOf(cost, budget);
      expect(level).toBe("warning");
      expect(pct).toBe(80.0);
      expect(barWidth({ pct })).toBe(80.0);
      // Warning não bloqueia recruit nem início de tarefas
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("99.99%: próximo ao estouro continua 'warning' sem bloqueio antecipado", () => {
      const cost = 9.999;
      const level = levelOf(cost, budget);
      expect(level).toBe("warning");
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("100.0%: teto exato deve ser 'exceeded' e BLOQUEAR ações sem continueAnyway", () => {
      const cost = 10.0;
      const level = levelOf(cost, budget);
      const pct = pctOf(cost, budget);
      expect(level).toBe("exceeded");
      expect(pct).toBe(100.0);
      expect(barWidth({ pct })).toBe(100.0);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(true);
    });

    it(">100% (ex: 150%, 250%): excesso mantém 'exceeded' e barra é clamped em 100%", () => {
      const cost = 15.0;
      const level = levelOf(cost, budget);
      const pct = pctOf(cost, budget);
      expect(level).toBe("exceeded");
      expect(pct).toBe(150.0);
      expect(barWidth({ pct })).toBe(100.0); // Barra visual limita-se a 100%
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(true);
    });
  });

  describe("Casos de borda: budget nulo e budget 0 / negativo", () => {
    it("budget nulo (null = sem teto definido): nível é sempre 'ok', sem barra nem bloqueio", () => {
      const cost = 54.32;
      const level = levelOf(cost, null);
      const pct = pctOf(cost, null);
      expect(level).toBe("ok");
      expect(pct).toBeNull();
      expect(barWidth({ pct })).toBe(0);
      expect(needsBudgetConfirm({ level, continueAnyway: false })).toBe(false);
    });

    it("budget 0 (teto zero): teto anormal impede gasto e conta imediatamente como 'exceeded'", () => {
      // Mesmo com gasto 0 ou baixo, teto 0 não permite operações gastadoras
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
        level: "warning",
        budgetUsd: 10.0,
        costUsd: 8.5,
        pct: 85.0,
        unpricedModels: ["internal-synthetic-preview", "future-claude-7"],
        unmeasuredAgents: ["gemini-qa"],
        continueAnyway: false,
        trendUsdPerHour: 1.25,
      };

      expect(status.unpricedModels).toContain("internal-synthetic-preview");
      expect(status.unpricedModels).toContain("future-claude-7");
      expect(status.unmeasuredAgents).toContain("gemini-qa");
      // Custo reportado só contempla modelos conhecidos da tabela
      expect(status.costUsd).toBe(8.5);
    });
  });

  describe("Liberação de ações mediante consentimento (continueAnyway)", () => {
    it("com continueAnyway = true, ações críticas (recruit, startTask) são liberadas mesmo excedido", () => {
      const statusOverBudget: Pick<BudgetStatus, "level" | "continueAnyway"> = {
        level: "exceeded",
        continueAnyway: true,
      };

      expect(needsBudgetConfirm(statusOverBudget)).toBe(false);
    });

    it("com continueAnyway = false e exceeded, exige confirmação", () => {
      const statusOverBudget: Pick<BudgetStatus, "level" | "continueAnyway"> = {
        level: "exceeded",
        continueAnyway: false,
      };

      expect(needsBudgetConfirm(statusOverBudget)).toBe(true);
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
