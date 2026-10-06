import { describe, expect, it } from "vitest";

import { barWidth } from "../BudgetBar";
import { levelOf, nearLimit, needsBudgetConfirm } from "../budgetTypes";

describe("levelOf", () => {
  it("ok abaixo de 80%, aviso a partir de 80%, estourado a partir de 100%", () => {
    expect(levelOf(7.99, 10)).toBe("ok");
    expect(levelOf(8, 10)).toBe("warning");
    expect(levelOf(9.99, 10)).toBe("warning");
    expect(levelOf(10, 10)).toBe("exceeded");
    expect(levelOf(25, 10)).toBe("exceeded");
  });
  it("sem teto, sempre ok", () => {
    expect(levelOf(999, null)).toBe("ok");
    expect(levelOf(5, 0)).toBe("ok");
  });
});

describe("needsBudgetConfirm", () => {
  it("só pede confirmação se estourou e o usuário ainda não escolheu continuar", () => {
    expect(needsBudgetConfirm({ level: "exceeded", continueAnyway: false })).toBe(true);
    expect(needsBudgetConfirm({ level: "exceeded", continueAnyway: true })).toBe(false);
    expect(needsBudgetConfirm({ level: "warning", continueAnyway: false })).toBe(false);
  });
});

describe("barWidth / nearLimit", () => {
  it("limita a barra a 0-100 e fica vazia sem medição", () => {
    expect(barWidth({ pct: 150 })).toBe(100);
    expect(barWidth({ pct: -3 })).toBe(0);
    expect(barWidth({ pct: null })).toBe(0);
    expect(barWidth({ pct: Number.NaN })).toBe(0);
    expect(barWidth({ pct: 42 })).toBe(42);
  });
  it("perto do limite a partir de 80%; não medido nunca avisa", () => {
    expect(nearLimit({ label: "5h", usedPct: 80, resetsAt: null })).toBe(true);
    expect(nearLimit({ label: "5h", usedPct: 79, resetsAt: null })).toBe(false);
    expect(nearLimit({ label: "5h", usedPct: null, resetsAt: null })).toBe(false);
  });
});
