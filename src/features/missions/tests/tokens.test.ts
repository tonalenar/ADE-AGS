import { describe, expect, it } from "vitest";

import { cacheReadShare, formatCompactNumber, tokenRows, type AgentTokens, type MissionTokens } from "../tokens";

describe("formatCompactNumber", () => {
  it("mostra números abaixo de mil como estão", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(1)).toBe("1");
    expect(formatCompactNumber(930)).toBe("930");
    expect(formatCompactNumber(999)).toBe("999");
  });

  it("compacta milhares com 'mil' e vírgula decimal", () => {
    expect(formatCompactNumber(1_000)).toBe("1 mil");
    expect(formatCompactNumber(1_200)).toBe("1,2 mil");
    expect(formatCompactNumber(12_300)).toBe("12,3 mil");
    expect(formatCompactNumber(999_999)).toBe("1000 mil");
  });

  it("compacta milhões com 'mi'", () => {
    expect(formatCompactNumber(1_000_000)).toBe("1 mi");
    expect(formatCompactNumber(4_500_000)).toBe("4,5 mi");
    expect(formatCompactNumber(10_000_000)).toBe("10 mi");
    expect(formatCompactNumber(12_345_678)).toBe("12,3 mi");
  });

  it("compacta bilhões com 'bi'", () => {
    expect(formatCompactNumber(1_000_000_000)).toBe("1 bi");
    expect(formatCompactNumber(2_500_000_000)).toBe("2,5 bi");
  });

  it("preserva números negativos e lida com valores não finitos", () => {
    expect(formatCompactNumber(-500)).toBe("-500");
    expect(formatCompactNumber(-12_300)).toBe("-12,3 mil");
    expect(formatCompactNumber(-4_500_000)).toBe("-4,5 mi");
    expect(formatCompactNumber(Number.NaN)).toBe("0");
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatCompactNumber(Number.NEGATIVE_INFINITY)).toBe("0");
  });
});

describe("cacheReadShare", () => {
  it("calcula a porcentagem arredondada do cache no input total", () => {
    const agent: AgentTokens = {
      agentId: "claude-code",
      measured: true,
      input: 10,
      output: 50,
      cacheWrite: 60,
      cacheRead: 30,
      costUsd: 0.05,
    };
    // total = 10 + 30 + 60 = 100; cacheRead = 30 -> 30%
    expect(cacheReadShare(agent)).toBe(30);
  });

  it("arredonda corretamente a fração percentual", () => {
    const agent: AgentTokens = {
      agentId: "claude-code",
      measured: true,
      input: 100,
      output: 20,
      cacheWrite: 0,
      cacheRead: 1,
      costUsd: null,
    };
    // 1 / 101 * 100 = 0.99% -> 1%
    expect(cacheReadShare(agent)).toBe(1);
  });

  it("retorna 0 quando cacheRead é 0 e há input medido", () => {
    const agent: AgentTokens = {
      agentId: "claude-code",
      measured: true,
      input: 500,
      output: 100,
      cacheWrite: 0,
      cacheRead: 0,
      costUsd: 0.02,
    };
    expect(cacheReadShare(agent)).toBe(0);
  });

  it("retorna null quando o agente não é medido (measured = false)", () => {
    const unmeasured: AgentTokens = {
      agentId: "codex",
      measured: false,
      input: 100,
      output: 50,
      cacheWrite: 20,
      cacheRead: 30,
      costUsd: 0.1,
    };
    expect(cacheReadShare(unmeasured)).toBeNull();
  });

  it("retorna null quando qualquer campo de token for null", () => {
    const base: AgentTokens = {
      agentId: "claude-code",
      measured: true,
      input: 100,
      output: 50,
      cacheWrite: 20,
      cacheRead: 30,
      costUsd: null,
    };
    expect(cacheReadShare({ ...base, input: null })).toBeNull();
    expect(cacheReadShare({ ...base, cacheWrite: null })).toBeNull();
    expect(cacheReadShare({ ...base, cacheRead: null })).toBeNull();
  });

  it("retorna null quando a soma dos tokens de input/cache for menor ou igual a zero", () => {
    const agent: AgentTokens = {
      agentId: "claude-code",
      measured: true,
      input: 0,
      output: 100,
      cacheWrite: 0,
      cacheRead: 0,
      costUsd: 0,
    };
    expect(cacheReadShare(agent)).toBeNull();
  });
});

describe("tokenRows", () => {
  it("devolve array vazio se não houver agentes", () => {
    expect(tokenRows({ agents: [] })).toEqual([]);
  });

  it("agente não medido mantém campos numéricos como null (nunca 0) para a UI exibir 'não medido'", () => {
    const data: MissionTokens = {
      agents: [
        {
          agentId: "codex",
          measured: false,
          input: null,
          output: null,
          cacheWrite: null,
          cacheRead: null,
          costUsd: 0.45,
        },
      ],
    };

    const rows = tokenRows(data);
    expect(rows).toHaveLength(2); // 1 agente + 1 total

    const agentRow = rows[0];
    expect(agentRow.agentId).toBe("codex");
    expect(agentRow.measured).toBe(false);
    expect(agentRow.input).toBeNull();
    expect(agentRow.output).toBeNull();
    expect(agentRow.cacheWrite).toBeNull();
    expect(agentRow.cacheRead).toBeNull();
    expect(agentRow.cacheReadSharePct).toBeNull();
    expect(agentRow.costUsd).toBe(0.45);
    expect(agentRow.isTotal).toBe(false);

    // Linha total quando todos são não-medidos também deve ter tokens como null (nunca 0)
    const totalRow = rows[1];
    expect(totalRow.isTotal).toBe(true);
    expect(totalRow.agentId).toBe("total");
    expect(totalRow.measured).toBe(false);
    expect(totalRow.input).toBeNull();
    expect(totalRow.output).toBeNull();
    expect(totalRow.cacheWrite).toBeNull();
    expect(totalRow.cacheRead).toBeNull();
    expect(totalRow.cacheReadSharePct).toBeNull();
    expect(totalRow.costUsd).toBe(0.45);
  });

  it("agente medido tem valores e share calculados e compõe o total", () => {
    const data: MissionTokens = {
      agents: [
        {
          agentId: "claude-code",
          measured: true,
          input: 1000,
          output: 500,
          cacheWrite: 200,
          cacheRead: 300,
          costUsd: 0.05,
        },
      ],
    };

    const rows = tokenRows(data);
    expect(rows).toHaveLength(2);

    const claudeRow = rows[0];
    expect(claudeRow.agentId).toBe("claude-code");
    expect(claudeRow.measured).toBe(true);
    expect(claudeRow.input).toBe(1000);
    expect(claudeRow.output).toBe(500);
    expect(claudeRow.cacheWrite).toBe(200);
    expect(claudeRow.cacheRead).toBe(300);
    expect(claudeRow.cacheReadSharePct).toBe(20); // 300 / (1000 + 300 + 200) * 100 = 20%
    expect(claudeRow.isTotal).toBe(false);

    const totalRow = rows[1];
    expect(totalRow.isTotal).toBe(true);
    expect(totalRow.measured).toBe(true);
    expect(totalRow.input).toBe(1000);
    expect(totalRow.output).toBe(500);
    expect(totalRow.cacheWrite).toBe(200);
    expect(totalRow.cacheRead).toBe(300);
    expect(totalRow.costUsd).toBe(0.05);
    expect(totalRow.cacheReadSharePct).toBe(20);
  });

  it("combina agente medido e não medido sem distorcer somatórios", () => {
    const data: MissionTokens = {
      agents: [
        {
          agentId: "claude-code",
          measured: true,
          input: 2000,
          output: 800,
          cacheWrite: 400,
          cacheRead: 600,
          costUsd: 0.1,
        },
        {
          agentId: "antigravity",
          measured: false,
          input: null,
          output: null,
          cacheWrite: null,
          cacheRead: null,
          costUsd: 0.25,
        },
        {
          agentId: "codex",
          measured: false,
          input: null,
          output: null,
          cacheWrite: null,
          cacheRead: null,
          costUsd: null,
        },
      ],
    };

    const rows = tokenRows(data);
    expect(rows).toHaveLength(4); // 3 agentes + 1 total

    // Agentes não medidos não se tornam 0
    expect(rows[1].input).toBeNull();
    expect(rows[1].cacheReadSharePct).toBeNull();
    expect(rows[2].input).toBeNull();
    expect(rows[2].cacheReadSharePct).toBeNull();

    // Linha total reflete apenas os medidos para tokens, mas soma custos presentes
    const totalRow = rows[3];
    expect(totalRow.isTotal).toBe(true);
    expect(totalRow.measured).toBe(true);
    expect(totalRow.input).toBe(2000);
    expect(totalRow.output).toBe(800);
    expect(totalRow.cacheWrite).toBe(400);
    expect(totalRow.cacheRead).toBe(600);
    expect(totalRow.costUsd).toBeCloseTo(0.35); // 0.10 + 0.25
    expect(totalRow.cacheReadSharePct).toBe(20); // 600 / (2000 + 600 + 400) * 100 = 20%
  });
});

import { sortedTabs, tabCostUsd, tabTotalTokens, tabsSum, type TabTokens } from "../tokens";

const tab = (over: Partial<TabTokens>): TabTokens => ({
  tabId: "t", label: "a", kind: "member", measured: true,
  input: 10, output: 5, cacheWrite: 0, cacheRead: 5, costUsd: 1, estimate: null, ...over,
});

describe("custo por aba", () => {
  it("aba sem medição vira null, nunca zero", () => {
    const t = tab({ measured: false, input: null, output: null, cacheWrite: null, cacheRead: null, costUsd: null });
    expect(tabCostUsd(t)).toBeNull();
    expect(tabTotalTokens(t)).toBeNull();
  });

  it("prefere a estimativa de tabela ao custo medido", () => {
    expect(tabCostUsd(tab({ costUsd: 1, estimate: { costUsd: 2, savedUsd: 0, unpricedModels: [] } }))).toBe(2);
    expect(tabCostUsd(tab({ costUsd: 1 }))).toBe(1);
    expect(tabTotalTokens(tab({}))).toBe(20);
  });

  it("ordena medidas mais caras primeiro e não medidas no fim", () => {
    const agent = {
      agentId: "x", measured: true, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0,
      tabs: [tab({ tabId: "n", label: "n", measured: false, costUsd: null }), tab({ tabId: "b", label: "b", costUsd: 1 }), tab({ tabId: "c", label: "c", costUsd: 3 })],
    };
    expect(sortedTabs(agent).map((x) => x.tabId)).toEqual(["c", "b", "n"]);
  });

  it("soma das abas bate com o total e ignora não medidas; vazio = null", () => {
    const agent = {
      agentId: "x", measured: true, input: 20, output: 10, cacheWrite: 0, cacheRead: 10, costUsd: 3,
      tabs: [tab({ costUsd: 1 }), tab({ costUsd: 2 }), tab({ measured: false, costUsd: null, input: null, output: null, cacheWrite: null, cacheRead: null })],
    };
    expect(tabsSum(agent)).toEqual({ tokens: 40, costUsd: 3 });
    expect(tabsSum({ ...agent, tabs: undefined })).toEqual({ tokens: null, costUsd: null });
  });
});
