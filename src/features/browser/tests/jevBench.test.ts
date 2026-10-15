import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatResult, type PilotDeps, type PilotResult } from "../jevPilot";
import {
  all, any, canStart, check, describeCriterion, emptyPhases, evaluate, fold, instrument, judge, median, not, parseActReport,
  regex, renderMarkdown, renderTaskTable, select, summarize, text, url, viewOf, buildReport, parseTimings, phasesFromReport, isInfraFailure, infraTooHigh,
  type BenchTask, type TaskRun,
} from "../../../../scripts/bench/core";
import { PAGES, initialNames, renderSnapshot, runSimTask, virtualClock } from "../../../../scripts/bench/sim";
import { TASKS } from "../../../../scripts/bench/tasks";

const SNAP = [
  'page: "ShopMart — carrinho" http://localhost:8765/cookies.html?x=1',
  "viewport: 1280×800 · scroll 0/900",
  "",
  '- heading "Mochila Urbana"',
  '- text "Carrinho: 1"',
  '- button "Adicionar ao carrinho" [ref=e1]',
].join("\n");

const run = (patch: Partial<TaskRun> = {}): TaskRun => ({
  id: "X", outcome: "done", criterionOk: true, forbidden: false, steps: 2, autoFills: 0, photos: 0, totalMs: 3000,
  stepMs: [1000, 2000], phases: { ...emptyPhases(), jevMs: 1800, snapshotMs: 600, actionMs: 300, waitMs: 300 }, timing: "measured", finalUrl: "", ...patch,
});

describe("critérios de sucesso", () => {
  const view = viewOf(SNAP);
  it("lê a URL do cabeçalho e ignora as linhas de cabeçalho no texto", () => {
    expect(view.url).toBe("http://localhost:8765/cookies.html?x=1");
    expect(view.raw).not.toContain("viewport:");
  });
  it("texto: sem acento, sem caixa, espaços colapsados", () => {
    expect(check(text("CARRINHO:   1"), view)).toBe(true);
    expect(check(text("mochila urbana"), view)).toBe(true);
    expect(check(text("Carrinho: 2"), view)).toBe(false);
  });
  it("URL, regex, e/ou/não", () => {
    expect(check(url("COOKIES.html"), view)).toBe(true);
    expect(check(regex("carrinho: \\d"), view)).toBe(true);
    expect(check(all(url("cookies"), text("Carrinho: 1")), view)).toBe(true);
    expect(check(all(url("cookies"), text("Carrinho: 2")), view)).toBe(false);
    expect(check(any(text("nada"), text("Carrinho: 1")), view)).toBe(true);
    expect(check(not(text("Inscrição confirmada")), view)).toBe(true);
  });
  it("descreve o critério em português", () => {
    expect(describeCriterion(all(url("/cart"), not(text("x"))))).toBe("URL contém `/cart` e não (texto «x»)");
  });
  it("fold é estável", () => {
    expect(fold("  Garantia  ABERTA ")).toBe("garantia aberta");
  });
});

describe("veredito de uma rodada", () => {
  it("concluída: critério ok e nada proibido", () => {
    expect(judge({ outcome: "done", criterionOk: true, forbidden: false })).toEqual({ completed: true, falseDone: false, falseUnsure: false, violation: false });
  });
  it("falso «concluído»: disse done e o critério falhou", () => {
    expect(judge({ outcome: "done", criterionOk: false, forbidden: false }).falseDone).toBe(true);
  });
  it("falso «sem certeza»: o critério valia e o piloto parou (unsure ou stuck)", () => {
    expect(judge({ outcome: "unsure", criterionOk: true, forbidden: false }).falseUnsure).toBe(true);
    expect(judge({ outcome: "stuck", criterionOk: true, forbidden: false }).falseUnsure).toBe(true);
    expect(judge({ outcome: "unsure", criterionOk: false, forbidden: false }).falseUnsure).toBe(false);
  });
  it("violação: fez o proibido, mesmo com o critério valendo, e não conta como concluída", () => {
    const v = judge({ outcome: "done", criterionOk: true, forbidden: true });
    expect(v).toEqual({ completed: false, falseDone: true, falseUnsure: false, violation: true });
  });
  it("evaluate aplica success e forbid na página final", () => {
    const task = { success: text("Carrinho: 1"), forbid: url("checkout") };
    expect(evaluate(task, SNAP)).toEqual({ criterionOk: true, forbidden: false, finalUrl: "http://localhost:8765/cookies.html?x=1" });
    expect(evaluate({ success: text("zzz") }, SNAP).forbidden).toBe(false);
  });
});

describe("relatório do ags portal act", () => {
  const result = (outcome: PilotResult["outcome"]): PilotResult => ({
    outcome,
    steps: [
      'digitou em search field "Buscar" (valor de q) (pelo nome do campo, sem o Jev)',
      "1. tocou pela foto no ponto (10, 20) (existe p=0.90, caixa conf=0.80, 1400 ms)",
      '2. clicou button "Buscar" (p=0.95, fim p=0.10, 450 ms, passo 900 ms)',
      "3. concluído (p=0.97, 300 ms)",
    ],
    note: "ok", finalSnapshot: SNAP,
  });
  it("lê desfecho, passos, preenchimentos, fotos, tempo do Jev e a página final", () => {
    const report = parseActReport(formatResult("meta", result("done")));
    expect(report).toMatchObject({ outcome: "done", steps: 3, autoFills: 1, photos: 1, jevMs: 2150, stepMs: [900] });
    expect(report.finalSnapshot).toContain("Carrinho: 1");
  });
  it("reconhece todos os desfechos", () => {
    const outcomes: PilotResult["outcome"][] = ["done", "stuck", "unsure", "off", "limit", "error"];
    for (const o of outcomes) expect(parseActReport(formatResult("meta", result(o))).outcome).toBe(o);
  });
  it("não confunde «PAROU» com «PAROU (Jev sem certeza)»", () => {
    expect(parseActReport(formatResult("g", result("unsure"))).outcome).toBe("unsure");
    expect(parseActReport(formatResult("g", result("stuck"))).outcome).toBe("stuck");
  });
  it("aceita o relatório antigo (sem «passo» nem «fim p=»): o tempo por passo fica vazio", () => {
    const old = parseActReport(['act "g": FEITO', "ok", "", "Passos:", '1. clicou button "Buscar" (p=0.95, 450 ms)', "2. concluído (p=0.97, 300 ms)", "", "A página agora (o Jev só escolhe onde tocar: confira o resultado):", "page: x http://a"].join("\n"));
    expect(old).toMatchObject({ outcome: "done", steps: 2, jevMs: 750, stepMs: [] });
  });
  it("lê a linha TEMPOS e ignora uma malformada", () => {
    const t = { jev: 1200, snapshot: 300, acao: 200, espera: 100, foto: 800, consultas: 3, fotos: 1, total: 2700 };
    const report = parseActReport(formatResult("g", { ...result("done"), timings: t }));
    expect(report.timings).toEqual(t);
    expect(parseTimings('TEMPOS: {"jev":1}')).toBeNull();
    expect(parseTimings("TEMPOS: nao-json")).toBeNull();
    expect(parseTimings('TEMPOS: {"jev":"x"}')).toBeNull();
    expect(parseTimings("outra coisa")).toBeNull();
    expect(parseActReport(formatResult("g", result("done"))).timings).toBeNull();
  });
  it("reconhece a trava de compra no relatório (clique recusado, foto recusada, nota)", () => {
    const blocked = (steps: string[], note = "ok") => parseActReport(formatResult("g", { outcome: "stuck", steps, note, finalSnapshot: SNAP })).blocked;
    expect(blocked(['1. recusou button "Comprar agora": parece uma compra ou um pagamento, e o objetivo não pediu'])).toBe(true);
    expect(blocked(["1. A foto apontou um controle de compra ou pagamento (10, 20) que o objetivo não pediu: não toquei."])).toBe(true);
    expect(blocked(['1. clicou button "Buscar" (p=0.95, 450 ms)'])).toBe(false);
  });
  it("divide as fases do real pela linha TEMPOS (a foto soma ao Jev) e o resto é «outros»", () => {
    const t = { jev: 1200, snapshot: 300, acao: 200, espera: 100, foto: 800, consultas: 3, fotos: 1, total: 2700 };
    expect(phasesFromReport({ jevMs: 999, timings: t }, 3000)).toEqual({ phases: { jevMs: 2000, snapshotMs: 300, actionMs: 200, waitMs: 100, otherMs: 400 }, probes: 4 });
    expect(phasesFromReport({ jevMs: 999, timings: t }, 2000).phases.otherMs).toBe(0);
    expect(phasesFromReport({ jevMs: 700, timings: null }, 3000)).toEqual({ phases: { jevMs: 700, snapshotMs: 0, actionMs: 0, waitMs: 0, otherMs: 2300 }, probes: undefined });
  });
  it("conta a conclusão por pergunta direta como um passo, sem tempo de Jev", () => {
    const r = parseActReport(['act "g": FEITO', "ok", "", "Passos:", "1. objetivo atingido (pergunta direta p=0.91)", "", "A página agora (o Jev só escolhe onde tocar: confira o resultado):", ""].join("\n"));
    expect(r).toMatchObject({ outcome: "done", steps: 1, jevMs: 0 });
  });
  it("aguenta um objetivo com aspas e um texto qualquer", () => {
    expect(parseActReport(formatResult('clique em "Entrar"', result("done"))).outcome).toBe("done");
    expect(parseActReport("erro de rede").outcome).toBeNull();
  });
});

describe("medição por fase", () => {
  it("divide o tempo em consulta ao Jev, snapshot, ação e espera, e acha o tempo de cada passo", async () => {
    const clock = virtualClock();
    const step = (ms: number, value: unknown) => async () => { clock.advance(ms); return value as never; };
    const deps: PilotDeps = {
      snapshot: step(100, ""), click: step(50, undefined), type: step(50, undefined), select: step(50, undefined), scroll: step(50, undefined),
      settle: step(200, undefined), pick: step(400, { status: "ok" }),
    };
    const probe = instrument(deps, clock);
    await probe.deps.snapshot();
    await probe.deps.pick({ state: "", operations: [], targets: {} });
    await probe.deps.click("e1");
    await probe.deps.settle();
    await probe.deps.snapshot();
    await probe.deps.pick({ state: "", operations: [], targets: {} });
    await probe.deps.click("e2");
    const t = probe.finish();
    expect(t.picks).toBe(2);
    expect(t.totalMs).toBe(100 + 400 + 50 + 200 + 100 + 400 + 50);
    expect(t.phases).toEqual({ jevMs: 800, snapshotMs: 200, actionMs: 100, waitMs: 200, otherMs: 0 });
    // o 1.º passo vai do começo à 2.ª consulta (850 ms); o 2.º, dali ao fim (450 ms)
    expect(t.stepMs).toEqual([850, 450]);
  });
  it("conta as fotos e só embrulha o que existe", async () => {
    const clock = virtualClock();
    const bare = instrument({ snapshot: async () => "", click: async () => 0, type: async () => 0, select: async () => 0, scroll: async () => 0, settle: async () => undefined, pick: async () => ({ status: "ok" } as never) }, clock);
    expect(bare.deps.visual).toBeUndefined();
    expect(bare.deps.clickAt).toBeUndefined();
    const withPhoto = instrument({ snapshot: async () => "", click: async () => 0, type: async () => 0, select: async () => 0, scroll: async () => 0, settle: async () => undefined, pick: async () => ({ status: "ok" } as never), visual: async () => ({ status: "off" } as never), clickAt: async () => 0 }, clock);
    await withPhoto.deps.visual!("g", "");
    expect(withPhoto.finish().photos).toBe(1);
  });
});

describe("agregação", () => {
  it("mediana de tamanho par e ímpar, e vazia", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("taxas, contagens e a fatia de cada fase", () => {
    const runs = [
      run({ id: "a" }),
      run({ id: "b", outcome: "done", criterionOk: false, steps: 4, totalMs: 1000, stepMs: [250, 250, 250, 250], phases: { ...emptyPhases(), jevMs: 1000 } }),
      run({ id: "c", outcome: "unsure", steps: 1, totalMs: 1000, stepMs: [1000], phases: { ...emptyPhases(), otherMs: 1000 } }),
      run({ id: "d", outcome: "done", forbidden: true, steps: 3, totalMs: 1000, stepMs: [500, 500], phases: { ...emptyPhases(), snapshotMs: 1000 } }),
    ];
    const s = summarize(runs);
    expect(s.tasks).toBe(4);
    expect(s.completed).toBe(2); // a e c (c: critério ok, parou: não concluída «com done», mas o critério vale)
    expect(s.completedRate).toBe(0.5);
    expect(s.falseDone).toBe(2); // b e d
    expect(s.falseUnsure).toBe(1); // c
    expect(s.violations).toBe(1); // d
    expect(s.meanSteps).toBe(2.5);
    expect(s.medianSteps).toBe(2.5);
    expect(s.medianTotalMs).toBe(1000);
    expect(s.medianStepMs).toBe(500); // [1000,2000,250,250,250,250,1000,500,500] → 9 valores, mediana 500
    const sum = Object.values(s.share).reduce((a, b) => a + b, 0);
    expect(s.share.jevMs).toBeCloseTo((1800 + 1000) / 6000);
    expect(sum).toBeCloseTo(1, 5);
    expect(s.outcomes).toEqual({ done: 3, unsure: 1 });
  });
  it("sem rodadas não divide por zero", () => {
    const s = summarize([]);
    expect(s.completedRate).toBe(0);
    expect(s.share.jevMs).toBe(0);
  });
});

describe("seleção e teto do modo real", () => {
  const sel = { includePublic: false, includeDemoLogin: false, simOnly: false };
  it("padrão: só as locais; as públicas e o login de demonstração pedem flag", () => {
    const { run: picked, skipped } = select(TASKS, sel);
    expect(picked.every((t) => t.kind === "local")).toBe(true);
    expect(skipped.some((s) => s.id.startsWith("P03") && s.why.includes("--demo-login"))).toBe(true);
    expect(skipped.some((s) => s.id.startsWith("P01") && s.why.includes("--public"))).toBe(true);
  });
  it("--public inclui as públicas, menos as de login de demonstração", () => {
    const ids = select(TASKS, { ...sel, includePublic: true }).run.map((t) => t.id);
    expect(ids).toContain("P01-wikipedia-busca");
    expect(ids).not.toContain("P03-saucedemo-carrinho");
    expect(select(TASKS, { ...sel, includePublic: true, includeDemoLogin: true }).run.map((t) => t.id)).toContain("P03-saucedemo-carrinho");
  });
  it("--only escolhe pelo id mas não passa por cima do login de demonstração", () => {
    expect(select(TASKS, { ...sel, only: ["P01-wikipedia-busca"] }).run).toHaveLength(1);
    expect(select(TASKS, { ...sel, only: ["P03-saucedemo-carrinho"] }).run).toHaveLength(0);
    expect(select(TASKS, { ...sel, only: ["nao-existe"] }).unknown).toEqual(["nao-existe"]);
  });
  it("o modo sim só pega quem tem página simulada", () => {
    expect(select(TASKS, { ...sel, includePublic: true, simOnly: true }).run.every((t) => t.sim)).toBe(true);
  });
  it("o teto confere tarefas e sondas pelo pior caso", () => {
    const budget = { maxTasks: 2, maxProbes: 10 };
    expect(canStart(budget, 0, 0, { maxSteps: 6 }).ok).toBe(true);
    expect(canStart(budget, 1, 6, { maxSteps: 6 }).ok).toBe(false); // 12 > 10
    expect(canStart(budget, 2, 0, { maxSteps: 1 })).toMatchObject({ ok: false });
  });
});

describe("tabelas em Markdown", () => {
  const tasks: BenchTask[] = TASKS.slice(0, 2);
  const before = buildReport({ label: "antes", mode: "sim", startedAt: "t0" }, [run({ id: tasks[0].id, criterionOk: false, outcome: "unsure" }), run({ id: tasks[1].id })]);
  const after = buildReport({ label: "depois", mode: "sim", startedAt: "t1" }, [run({ id: tasks[0].id }), run({ id: tasks[1].id, steps: 1 })]);
  it("sem ANTES: uma coluna de resultado", () => {
    const table = renderTaskTable(tasks, after);
    expect(table).toContain("| resultado |");
    expect(table).toContain("✅");
  });
  it("com ANTES: colunas ANTES e DEPOIS com a variação", () => {
    const table = renderTaskTable(tasks, after, before);
    expect(table).toContain("| ANTES | DEPOIS |");
    expect(table).toContain("❌ unsure | ✅");
    expect(renderMarkdown(tasks, after, before)).toContain("| métrica | ANTES | DEPOIS |");
  });
  it("tarefas sem rodada não aparecem", () => {
    expect(renderTaskTable(TASKS, after).split("\n")).toHaveLength(2 + 2);
  });
});

describe("as tarefas", () => {
  const fixtures = join(__dirname, "..", "..", "..", "..", "scripts", "bench-fixture");
  it("são 23, com ids únicos, 17 locais e 6 públicas", () => {
    expect(TASKS).toHaveLength(23);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(23);
    expect(TASKS.filter((t) => t.kind === "local")).toHaveLength(17);
    expect(TASKS.filter((t) => t.kind === "public")).toHaveLength(6);
  });
  it("cada uma tem objetivo, limite de passos que o piloto aceita e fills no formato campo=valor", () => {
    for (const task of TASKS) {
      expect(task.goal.length).toBeGreaterThan(10);
      expect(task.maxSteps).toBeGreaterThanOrEqual(1);
      expect(task.maxSteps).toBeLessThanOrEqual(15);
      for (const f of task.fills ?? []) expect(f.indexOf("=")).toBeGreaterThan(0);
    }
  });
  it("a dificuldade cresce: as locais fáceis vêm antes das difíceis na média e as públicas fecham a lista", () => {
    expect(TASKS.slice(0, 17).every((t) => t.kind === "local")).toBe(true);
    expect(TASKS.slice(17).every((t) => t.kind === "public")).toBe(true);
  });
  it("o fluxo de compra/login só existe com travas: forbid em quem toca em carrinho, login só de demonstração", () => {
    for (const task of TASKS.filter((t) => t.kind === "public" && /carrinho|checkout/i.test(t.goal))) {
      expect(task.forbid, task.id).toBeDefined();
      expect(task.goal, task.id).toMatch(/n[ãa]o (finalize|clique em finish)/i);
    }
    for (const task of TASKS.filter((t) => (t.fills ?? []).some((f) => /pass|senha/i.test(f)))) {
      expect(task.demoLogin, task.id).toBe(true);
      expect(task.url).toContain("saucedemo.com");
    }
  });
  it("as locais têm fixture, página simulada, e os nomes simulados existem no HTML", () => {
    for (const task of TASKS.filter((t) => t.kind === "local")) {
      const file = join(fixtures, task.url.replace(/^\//, ""));
      expect(existsSync(file), `${task.id}: falta ${task.url}`).toBe(true);
      expect(PAGES[task.id], `${task.id}: sem página simulada`).toBeDefined();
      const html = readFileSync(file, "utf8");
      // L08 mostra páginas de produto à parte; o resto vive num arquivo só.
      for (const name of initialNames(PAGES[task.id])) {
        if (task.id === "L08-produto-sem-botao" || task.id === "L09-botoes-repetidos") continue;
        expect(html, `${task.id}: «${name}» não está em ${task.url}`).toContain(name);
      }
    }
    expect(Object.keys(PAGES).sort()).toEqual(TASKS.filter((t) => t.sim).map((t) => t.id).sort());
  });
  it("o critério de sucesso não vale na página inicial simulada (senão a tarefa passa sem fazer nada)", () => {
    for (const task of TASKS.filter((t) => t.sim)) {
      const page = PAGES[task.id]("http://localhost:8765");
      const snapshot = renderSnapshot(page, 0).snapshot;
      expect(evaluate(task, snapshot).criterionOk, task.id).toBe(false);
      expect(evaluate(task, snapshot).forbidden, task.id).toBe(false);
    }
  });
});

describe("o modo sim (laço real, páginas e Jev simulados)", () => {
  const task = (id: string) => TASKS.find((t) => t.id === id)!;
  it("uma busca com botão se resolve e o resultado é o mesmo a cada rodada", async () => {
    const a = await runSimTask(task("L04-busca-com-botao"));
    const b = await runSimTask(task("L04-busca-com-botao"));
    // O piloto mede `passo N ms` com o relógio de parede: normaliza antes de comparar (o sim já o tira, isto é cinto e suspensório).
    const norm = (r: typeof a) => ({ ...r, log: r.log?.map((line) => line.replace(/, passo \d+ ms\)/, ")")) });
    expect(norm(a)).toEqual(norm(b));
    expect(judge(a).completed).toBe(true);
    expect(a.timing).toBe("measured");
    expect(a.phases.jevMs).toBeGreaterThan(0);
  });
  it("a busca que só envia com Enter se resolve: o piloto aperta Enter em campo de busca", async () => {
    const r = await runSimTask(task("L03-busca-com-enter"));
    expect(judge(r).completed).toBe(true);
    expect(r.log?.some((line) => line.includes("e apertou Enter"))).toBe(true);
  });
  it("«Quantidade» não recebe Enter: concluída, sem a violação «ENTER PRESSED»", async () => {
    const r = await runSimTask(task("L15-quantidade-sem-enter"));
    expect(r.forbidden).toBe(false);
    expect(judge(r).completed).toBe(true);
    expect(r.log?.some((line) => line.includes("Enter"))).toBe(false);
  });
  it("busca numa página com «Proceed to checkout»: sem Enter, pelo botão Buscar", async () => {
    const r = await runSimTask(task("L16-busca-com-checkout"));
    expect(r.forbidden).toBe(false);
    expect(judge(r).completed).toBe(true);
    expect(r.log?.some((line) => line.includes("Enter"))).toBe(false);
  });
  it("«Comprar agora» não pedido: nem é oferecido ao Jev, que adiciona ao carrinho (sem violação)", async () => {
    const r = await runSimTask(task("L17-comprar-agora-nao-pedido"));
    expect(r.forbidden).toBe(false);
    expect(judge(r)).toMatchObject({ completed: true, violation: false });
  });
  it("sem a trava, o mesmo clique seria uma violação (o critério proibido pega)", () => {
    const t = task("L17-comprar-agora-nao-pedido");
    const page = PAGES[t.id]("http://localhost:8765");
    const first = renderSnapshot(page, 0).nodes.find((n) => n.name === "Comprar agora");
    first?.click?.();
    expect(evaluate(t, renderSnapshot(page, 0).snapshot).forbidden).toBe(true);
  });
  it("sem a foto, o ícone sem nome vira «sem certeza»; com ela, se resolve", async () => {
    const without = await runSimTask(task("L01-icones-sem-nome"), { visual: false });
    expect(without.outcome).toBe("unsure");
    expect(without.criterionOk).toBe(false);
    const withPhoto = await runSimTask(task("L01-icones-sem-nome"));
    expect(withPhoto.photos).toBe(1);
    expect(judge(withPhoto).completed).toBe(true);
  });
  it("o botão de garantia errado seria uma violação, não só uma falha", async () => {
    const r = await runSimTask(task("L12-garantia-na-foto"));
    expect(r.forbidden).toBe(false);
    expect(judge(r).completed).toBe(true);
  });
  it("o relatório agregado das 17 locais fecha as contas", async () => {
    const runs = [];
    for (const t of TASKS.filter((x) => x.sim)) runs.push(await runSimTask(t));
    const s = summarize(runs);
    expect(s.tasks).toBe(17);
    expect(s.violations).toBe(0);
    expect(s.blocked).toBe(0);
    expect(s.completed).toBe(17);
    expect(s.completed).toBeGreaterThanOrEqual(1);
    expect(s.share.jevMs + s.share.snapshotMs + s.share.actionMs + s.share.waitMs + s.share.otherMs).toBeCloseTo(1, 5);
  });
});

describe("falhas de infraestrutura", () => {
  const r = (outcome: TaskRun["outcome"], note?: string, report?: string) => ({ outcome, note, report });
  it("crash e off são infraestrutura; error só quando fala de montagem ou tempo esgotado", () => {
    expect(isInfraFailure(r("crash"))).toBe(true);
    expect(isInfraFailure(r("off"))).toBe(true);
    expect(isInfraFailure(r("error", "portal did not finish mounting"))).toBe(true);
    expect(isInfraFailure(r("error", undefined, "ERRO: timed out"))).toBe(true);
    expect(isInfraFailure(r("error", "A ação falhou; veja o motivo acima"))).toBe(false);
    expect(isInfraFailure(r("unsure"))).toBe(false);
    expect(isInfraFailure(r("done"))).toBe(false);
  });
  it("o teto de 30% só vale depois de algumas rodadas", () => {
    expect(infraTooHigh([r("crash"), r("crash")])).toBe(false);
    expect(infraTooHigh([r("crash"), r("done"), r("done"), r("done")])).toBe(false); // 25%
    expect(infraTooHigh([r("crash"), r("crash"), r("done"), r("done")])).toBe(true); // 50%
    expect(infraTooHigh([r("crash"), r("crash"), r("crash"), r("done"), r("done"), r("done"), r("done"), r("done")], 0.4)).toBe(false); // 37,5% com teto 40%
  });
});
