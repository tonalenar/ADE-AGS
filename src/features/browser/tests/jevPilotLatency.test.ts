import { describe, expect, it } from "vitest";

import {
  MAX_TABLE, TABLE_LABEL_CHARS, TEXT_BYTES, buildStep, emptyTimings, formatResult, median, parseSnapshot, percentile, pickText, queriesLine, runPilot, timed,
  type PilotDeps, type QueryCost, type StepQuery, type StepReply,
} from "../jevPilot";

// Plano v2, 4.2 (achado D2): medir bytes, tokens e latência por consulta, e cortar o que o Jev não precisa ler.

const LOGIN = [
  'page: "Entrar — Loja" http://localhost:5173/login',
  "viewport: 1280×800 · scroll 0/800",
  "",
  '- heading "Bem-vindo"',
  '- textbox "E-mail" [ref=e1] value=""',
  '- button "Entrar" [ref=e4]',
  '- link "Esqueci a senha" [ref=e6] → /reset',
].join("\n");

const cost = (over: Partial<QueryCost> = {}): QueryCost => ({
  stateBytes: 900, requestBytes: 2400, responseBytes: 300, inputTokens: 610, outputTokens: 5, questions: 3, options: 12,
  scanMs: 2, attempts: 1, backoffMs: 0, timeoutMs: 3000, ...over,
});

const reply = (operation: string, target: string | null, over: Partial<StepReply> = {}): StepReply =>
  ({ status: "ok", operation, target, probability: 0.9, goalDone: null, reason: null, latencyMs: 300, cost: cost(), ...over });

describe("medição por consulta", () => {
  it("a mediana e o p95 saem da lista de latências", () => {
    expect(median([])).toBe(0);
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.95)).toBe(1000);
    expect(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.5)).toBe(500);
  });

  it("soma bytes, tokens, repetições e varredura de cada consulta nos tempos do act", async () => {
    const t = emptyTimings();
    const replies = [reply("click", "e4", { latencyMs: 420 }), reply("done", null, { latencyMs: 380, cost: cost({ requestBytes: 1800, attempts: 3, backoffMs: 750, inputTokens: 400 }) })];
    const deps: PilotDeps = {
      snapshot: async () => "", click: async () => 0, type: async () => 0, select: async () => 0, scroll: async () => 0, settle: async () => undefined,
      pick: async () => replies.shift()!,
    };
    const wrapped = timed(deps, t);
    await wrapped.pick({ state: "", operations: [], targets: {}, skipGoalDone: true });
    await wrapped.pick({ state: "", operations: [], targets: {} });
    expect(t.consultas).toBe(2);
    expect(t.bytes).toEqual([2400, 1800]);
    expect(t.consultaMs).toEqual([420, 380]);
    expect(t.tokens).toBe(615 + 405);
    expect(t.repeticoes).toBe(2);
    expect(t.esperaRede).toBe(750);
    expect(t.varredura).toBe(4);
    expect(t.semConcluido).toBe(1);
  });

  it("o relatório traz a linha CONSULTAS e a linha TEMPOS com bytes e tokens que o benchmark lê", async () => {
    const t = { ...emptyTimings(), consultas: 2, bytes: [2400, 1800], consultaMs: [420, 380], tokens: 1020, semConcluido: 1 };
    const line = queriesLine(t);
    expect(line).toContain("2 consulta(s)");
    expect(line).toContain("latência mediana 400 ms");
    expect(line).toContain("corpo mediano 2100 B");
    expect(line).toContain("1020 tokens");
    expect(queriesLine(emptyTimings())).toBe("CONSULTAS: nenhuma");
    const text = formatResult("g", { outcome: "done", steps: [], note: "ok", finalSnapshot: "page: x http://a", timings: t });
    expect(text).toContain("CONSULTAS: ");
    const json = JSON.parse(text.split("\n").find((l) => l.startsWith("TEMPOS: "))!.slice("TEMPOS: ".length));
    expect(json.bytes).toEqual([2400, 1800]);
    expect(json.tokens).toBe(1020);
  });
});

/** Uma página por passo; cada ação avança. `changed` decide se a ação muda a página (a impressão) ou deixa igual. */
function harness(script: StepReply[], changes: boolean[]) {
  const asked: StepQuery[] = [];
  let page = 0;
  let pick = 0;
  let warmed = 0;
  const pages = Array.from({ length: 8 }, (_, i) => LOGIN.replace("Bem-vindo", `Pagina ${i}`));
  const deps: PilotDeps = {
    warm: () => { warmed++; },
    snapshot: async () => pages[Math.min(page, pages.length - 1)],
    click: async () => { if (changes[Math.min(page, changes.length - 1)]) page++; else changes.shift(); },
    type: async () => { page++; }, select: async () => { page++; }, scroll: async () => { page++; },
    settle: async () => undefined,
    pick: async (query) => { asked.push(query); return script[Math.min(pick++, script.length - 1)]; },
  };
  return { deps, asked, warmed: () => warmed };
}

describe("a pergunta direta de fim só vale depois de uma ação que mudou a página", () => {
  it("a primeira consulta e a seguinte a uma ação que não mudou nada não pedem o concluido", async () => {
    // click e4 (a página não muda) → click e6 (muda) → done
    const h = harness([reply("click", "e4"), reply("click", "e6"), reply("done", null)], [false, true]);
    await runPilot("entrar", [], undefined, h.deps);
    expect(h.asked.length).toBe(3);
    expect(h.asked[0].skipGoalDone).toBe(true); // nada feito ainda
    expect(h.asked[1].skipGoalDone).toBe(true); // a última ação não mudou a página
    expect(h.asked[2].skipGoalDone).toBeFalsy(); // a última mudou: o concluido vale
  });

  it("abre a conexão com o Jev ao começar", async () => {
    const h = harness([reply("done", null)], [true]);
    await runPilot("entrar", [], undefined, h.deps);
    expect(h.warmed()).toBe(1);
  });

  it("uma falha ao pré-conectar não derruba o act", async () => {
    const h = harness([reply("done", null)], [true]);
    h.deps.warm = () => { throw new Error("sem rede"); };
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
  });
});

describe("o estado que vai ao Jev é cortado", () => {
  const big = (n: number, fields = 0) => [
    'page: "Loja" http://localhost/lista',
    "viewport: 1280×800 · scroll 0/800",
    "",
    ...Array.from({ length: n }, (_, i) => `- link "Produto número ${i} ${"com um nome bem comprido ".repeat(6)}" [ref=e${i + 1}] → /p/${i}`),
    ...Array.from({ length: fields }, (_, i) => `- textbox "Campo ${i}" [ref=e${n + i + 1}] value=""`),
  ].join("\n");

  it("a tabela leva no máximo MAX_TABLE elementos, com rótulos cortados, mas as perguntas de alvo levam todos (até 100)", () => {
    const query = buildStep(parseSnapshot(big(150, 60)), "abrir o produto número 7", ["campo"], []);
    const rows = query.state.split("\n").filter((l) => /^\[e\d+\] /.test(l));
    expect(rows.length).toBe(MAX_TABLE);
    expect(rows.every((r) => r.replace(/^\[e\d+\] /, "").length <= TABLE_LABEL_CHARS)).toBe(true);
    expect(query.state).toContain("more elements offered in the questions below");
    expect(query.targets.click.length).toBe(100);
    expect(query.targets.type.length).toBe(60);
    // o que o objetivo cita fica na tabela
    expect(rows.some((r) => r.startsWith("[e8] "))).toBe(true);
  });

  it("uma página pequena não perde nada: sem corte, sem aviso", () => {
    const query = buildStep(parseSnapshot(big(5)), "abrir", [], []);
    expect(query.state).not.toContain("more elements");
    expect(query.state.split("\n").filter((l) => /^\[e\d+\] /.test(l)).length).toBe(5);
  });

  it("o texto visível cabe em TEXT_BYTES e as linhas do objetivo vêm primeiro", () => {
    const lines = [...Array.from({ length: 200 }, (_, i) => `Menu item ${i} da loja de departamentos`), "Seu carrinho está vazio"];
    const picked = pickText(lines, new Set(["carrinho", "vazio"]), TEXT_BYTES);
    expect(picked).toContain("Seu carrinho está vazio");
    expect(picked.join(" ").length).toBeLessThanOrEqual(TEXT_BYTES + picked.length);
  });
});
