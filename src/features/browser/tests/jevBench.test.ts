import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { emptyTimings, formatResult, type PilotDeps, type PilotResult } from "../jevPilot";
import {
  all, any, canStart, check, describeCriterion, emptyPhases, evaluate, fold, instrument, judge, median, not, parseActReport,
  regex, renderMarkdown, renderTaskTable, select, summarize, text, url, viewOf, buildReport, parseTimings, phasesFromReport, isInfraFailure, infraTooHigh, unwrapCli, mergeRuns, renderFailures, renderTrend,
  percentile, groupMetrics, summarizeV2, repetitionPlan, hashSeed, rng, shuffled, parseWindowLine, windowOf, queriesFromReport, mergeQueries, isWindowHang,
  parseDelay, MAX_DELAY_MS, fixtureApi, fixtureSearchPage,
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
    const report = parseActReport(formatResult("g", { ...result("done"), timings: { ...emptyTimings(), ...t } }));
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
  it("são 33, com ids únicos, 27 locais (17 + 10 da leva v2) e 6 públicas, 2 delas sondas (Amazon)", () => {
    expect(TASKS).toHaveLength(33);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(33);
    expect(TASKS.filter((t) => t.kind === "local")).toHaveLength(27);
    expect(TASKS.filter((t) => t.kind === "public")).toHaveLength(6);
    expect(TASKS.filter((t) => t.set === "v2")).toHaveLength(10);
    expect(TASKS.filter((t) => t.probe).map((t) => t.id)).toEqual(["P05-amazon-busca-adicionar", "P06-amazon-produto-adicionar"]);
  });
  it("a leva v2 cobre anúncios, busca lenta, autocomplete, re-render e carrinho (2 de cada)", () => {
    const v2 = TASKS.filter((t) => t.set === "v2");
    for (const tag of ["anuncio", "assincrona", "autocomplete", "rerender"]) expect(v2.filter((t) => t.tags.includes(tag)), tag).toHaveLength(2);
    expect(v2.filter((t) => t.tags.includes("idempotencia"))).toHaveLength(2);
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
    expect(TASKS.slice(0, 27).every((t) => t.kind === "local")).toBe(true);
    expect(TASKS.slice(27).every((t) => t.kind === "public")).toBe(true);
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
      const file = join(fixtures, task.url.replace(/^\//, "").split("?")[0]);
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
      const page = PAGES[task.id]("http://localhost:8765", { now: () => 0 });
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
    const page = PAGES[t.id]("http://localhost:8765", { now: () => 0 });
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
  it("o relatório agregado das 17 locais originais fecha as contas", async () => {
    const runs = [];
    for (const t of TASKS.filter((x) => x.sim && x.set !== "v2")) runs.push(await runSimTask(t));
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

describe("saída JSON do CLI", () => {
  it("devolve o campo text e deixa passar o que não é JSON de objeto com text", () => {
    const body = ['act "g": FEITO', "ok"].join("\n");
    expect(unwrapCli(JSON.stringify({ portal: { id: "p" }, text: body }))).toBe(body);
    expect(unwrapCli("page: x http://a")).toBe("page: x http://a");
    expect(unwrapCli('{"error":"falhou"}')).toBe('{"error":"falhou"}');
    expect(unwrapCli("{nao json")).toBe("{nao json");
  });
  it("o relatório do act embrulhado no JSON do CLI é reconhecido depois de desembrulhar", () => {
    const wrapped = JSON.stringify({ portal: { id: "p" }, text: ['act "g": FEITO', "ok", "", "Passos:", "1. concluído (p=0.97, 300 ms)"].join("\n") });
    expect(parseActReport(wrapped).outcome).toBeNull();
    expect(parseActReport(unwrapCli(wrapped)).outcome).toBe("done");
  });
});


describe("junção de rodadas e causas", () => {
  const mk = (id: string, patch: Partial<TaskRun> = {}): TaskRun => run({ id, ...patch });
  it("a última rodada que trouxe a tarefa vale, na ordem pedida", () => {
    const first = { runs: [mk("A", { outcome: "unsure", criterionOk: false }), mk("B")] };
    const second = { runs: [mk("A")] };
    const merged = mergeRuns([first, second], ["B", "A", "C"]);
    expect(merged.map((r) => r.id)).toEqual(["B", "A"]);
    expect(merged[1].outcome).toBe("done");
  });
  it("«confirmadas» exige done além do critério; a causa aparece na lista de falhas", () => {
    const runs = [mk("L04-busca-com-botao", { outcome: "stuck", cause: "sem certeza após ação" }), mk("L01-icones-sem-nome")];
    const s = summarize(runs);
    expect(s.completed).toBe(2);
    expect(s.confirmed).toBe(1);
    const report = buildReport({ label: "x", mode: "real", startedAt: "t" }, runs);
    const failures = renderFailures(TASKS, report);
    expect(failures).toContain("L04-busca-com-botao");
    expect(failures).toContain("**Causa:** sem certeza após ação");
    expect(failures).not.toContain("L01-icones-sem-nome");
  });
});

describe("estatísticas v2 (Fase 0.3)", () => {
  it("percentil por interpolação linear: p50 = mediana, p95 entre vizinhos, vazio = 0", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(median(xs));
    expect(percentile(xs, 95)).toBeCloseTo(19.05, 10);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([10, 0], 100)).toBe(10);
    expect(percentile([10, 0], 0)).toBe(0);
    expect(percentile([3, 1, 2, 4], 50)).toBe(2.5);
  });
  it("conta falso «feito» e falso «parou» contra o critério de cada rodada", () => {
    const g = groupMetrics([
      run({ id: "a" }), // ok
      run({ id: "a", outcome: "done", criterionOk: false }), // falso feito
      run({ id: "b", outcome: "unsure", criterionOk: true }), // falso parou (o critério valia)
      run({ id: "b", outcome: "stuck", criterionOk: true }), // falso parou
      run({ id: "c", outcome: "stuck", criterionOk: false }), // parou de verdade: nem falso feito nem falso parou
      run({ id: "c", outcome: "done", criterionOk: true, forbidden: true }), // violação: também falso feito
      run({ id: "d", outcome: "limit", criterionOk: false }), // limite: falha simples
    ]);
    expect(g).toMatchObject({ runs: 7, tasks: 4, successes: 3, falseDone: 2, falseStop: 2, violations: 1 });
    expect(g.successRate).toBeCloseTo(3 / 7);
  });
  it("p50/p95 por passo e por act, act por tarefa, consultas, tokens estimados e travamentos", () => {
    const q = (bytes: number[], latencyMs: number[]) => ({ count: bytes.length, bytes, latencyMs, tokens: Math.round(bytes.reduce((a, b) => a + b, 0) / 4), tokensEstimated: true });
    const g = groupMetrics([
      run({ stepMs: [100, 200], actMs: [300], acts: 1, queries: q([400, 800], [400, 500]) }),
      run({ stepMs: [300, 400], actMs: [500, 900], acts: 2, queries: q([1200], [600]), window: { lagMaxMs: 1800 } }),
      run({ outcome: "crash", criterionOk: false, stepMs: [], note: "act falhou: a janela não respondeu a tempo" }),
    ]);
    expect(g.stepP50).toBe(250);
    expect(g.stepP95).toBeCloseTo(385, 5);
    // os act: 300, 500, 900 e 3000 (a rodada sem actMs vale pelo tempo total)
    expect(g.actP50).toBe(700);
    expect(g.actsPerTask).toBeCloseTo(4 / 3);
    expect(g.queriesPerTask).toBeCloseTo((2 + 1 + 0) / 3);
    expect(g.tokensPerTask).toBe((300 + 300) / 2);
    expect(g.tokensEstimated).toBe(true);
    expect(g.bytesPerQueryP50).toBe(800);
    expect(g.queryLatencyP95).toBeCloseTo(590, 5);
    expect(g.windowHangs).toBe(1);
    expect(g.lagMaxMs).toBe(1800);
  });
  it("sem nenhum dado de consulta nem de janela, mostra «sem dado» (null), não zero", () => {
    const g = groupMetrics([run({ probes: 3 })]);
    expect(g.tokensPerTask).toBeNull();
    expect(g.bytesPerQueryP50).toBeNull();
    expect(g.lagMaxMs).toBeNull();
    expect(g.queriesPerTask).toBe(3);
  });
  it("sondas ficam fora do portão; locais × públicas separadas", () => {
    const tasks = [{ id: "L", kind: "local" as const }, { id: "P", kind: "public" as const }, { id: "A", kind: "public" as const, probe: true }];
    const v2 = summarizeV2(tasks, [run({ id: "L" }), run({ id: "P", outcome: "done", criterionOk: false }), run({ id: "A", outcome: "done", criterionOk: false })]);
    expect(v2.gate).toMatchObject({ runs: 2, successes: 1, falseDone: 1 });
    expect(v2.local).toMatchObject({ runs: 1, successes: 1 });
    expect(v2.public).toMatchObject({ runs: 1, falseDone: 1 });
    expect(v2.probe).toMatchObject({ runs: 1, falseDone: 1 });
    expect(v2.tasks.find((t) => t.id === "A")?.probe).toBe(true);
  });
  it("semente: a mesma dá a mesma ordem; repetições ímpares invertem a anterior; cada tarefa aparece uma vez por repetição", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const p1 = repetitionPlan(ids, 3, 7);
    expect(repetitionPlan(ids, 3, 7)).toEqual(p1);
    expect(p1[1].items).toEqual([...p1[0].items].reverse());
    for (const { items } of p1) expect([...items].sort()).toEqual(ids);
    expect(repetitionPlan(ids, 1, 8)[0].items).not.toEqual(repetitionPlan(ids, 1, 7)[0].items);
    expect(repetitionPlan(ids, 2, 7, false)[1].items).not.toEqual([...p1[0].items].reverse());
    expect(hashSeed(1, "x", 0)).toBe(hashSeed(1, "x", 0));
    expect(hashSeed(1, "x", 0)).not.toBe(hashSeed(1, "x", 1));
    const r = rng(42);
    const xs = [r(), r(), r()];
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(42)()).toBe(xs[0]);
    expect(shuffled([1, 2, 3], rng(1))).toHaveLength(3);
  });
});

describe("relatório do act v2: janela, consultas e travamento", () => {
  it("lê o batimento da janela em qualquer forma do contrato e ignora o que não é número", () => {
    expect(parseWindowLine('TEMPOS: {"jev":1,"window":{"lagMaxMs":1900,"lagP95Ms":300,"samples":40,"hiddenMs":0,"timeouts":0}}')).toEqual({ lagMaxMs: 1900, lagP95Ms: 300, samples: 40, hiddenMs: 0, timeouts: 0 });
    expect(parseWindowLine('window: {"lagMaxMs":120,"samples":"x"}')).toEqual({ lagMaxMs: 120 });
    expect(parseWindowLine('JANELA: {"window":{"timeouts":1}}')).toEqual({ timeouts: 1 });
    expect(parseWindowLine("janela: lag máx 2300 ms")).toEqual({ lagMaxMs: 2300 });
    expect(parseWindowLine('TEMPOS: {"jev":1}')).toBeNull();
    expect(parseWindowLine("window: {quebrado")).toBeNull();
    expect(windowOf(null)).toBeNull();
  });
  it("o relatório traz latências por consulta (não a da foto), a janela e os bytes/tokens quando houver", () => {
    const text = [
      'act "g": FEITO', "ok", "", "Passos:",
      "1. tocou pela foto no ponto (10, 20) (existe p=0.90, caixa conf=0.80, 1400 ms)",
      '2. clicou button "Buscar" (p=0.95, fim p=0.10, 450 ms, passo 900 ms)',
      "3. concluído (p=0.97, 300 ms)",
      'TEMPOS: {"jev":750,"snapshot":1,"acao":1,"espera":1,"foto":1400,"consultas":2,"fotos":1,"total":2200,"bytes":[1000,2000],"window":{"lagMaxMs":80}}',
      "", "A página agora (o Jev só escolhe onde tocar: confira o resultado):", "page: x http://a",
    ].join("\n");
    const r = parseActReport(text);
    expect(r.jevLatencies).toEqual([450, 300]);
    expect(r.window).toEqual({ lagMaxMs: 80 });
    expect(r.queryBytes).toEqual([1000, 2000]);
    expect(queriesFromReport(r)).toEqual({ count: 2, bytes: [1000, 2000], latencyMs: [450, 300], tokens: 750, tokensEstimated: true });
    expect(queriesFromReport({ ...r, tokens: 999 })).toMatchObject({ tokens: 999, tokensEstimated: false });
    expect(queriesFromReport({ ...r, queryBytes: [] }).tokens).toBeNull();
    expect(mergeQueries([queriesFromReport(r), queriesFromReport({ ...r, tokens: 10 })])).toMatchObject({ count: 4, tokens: 760, tokensEstimated: true });
  });
  it("relatório antigo, sem janela nem bytes: tolerante", () => {
    const r = parseActReport(['act "g": FEITO', "ok", "", "Passos:", "1. concluído (p=0.97, 300 ms)"].join("\n"));
    expect(r.window).toBeNull();
    expect(r.queryBytes).toEqual([]);
    expect(r.tokens).toBeNull();
  });
  it("travamento da janela: timeout da ponte ou timeouts no batimento; falha do piloto não conta", () => {
    expect(isWindowHang({ outcome: "crash", note: "act falhou: A janela não respondeu a tempo" })).toBe(true);
    expect(isWindowHang({ outcome: "error", report: "ask_frontend recv_timeout" })).toBe(true);
    expect(isWindowHang({ outcome: "done", window: { timeouts: 2 } })).toBe(true);
    expect(isWindowHang({ outcome: "done", note: "a janela não respondeu a tempo" })).toBe(false);
    expect(isWindowHang({ outcome: "error", note: "A ação falhou" })).toBe(false);
  });
});

describe("servidor das fixtures (Fase 0.4)", () => {
  it("?delay= em ms, com teto, e 0 quando ausente ou inválido", () => {
    expect(parseDelay("?delay=8000")).toBe(8000);
    expect(parseDelay("k=caneca&delay=700")).toBe(700);
    expect(parseDelay("?delay=999999")).toBe(MAX_DELAY_MS);
    expect(parseDelay("?delay=-5")).toBe(0);
    expect(parseDelay("?delay=abc")).toBe(0);
    expect(parseDelay("")).toBe(0);
  });
  it("a API responde JSON fictício às fixtures; rota desconhecida é 404", () => {
    expect(fixtureApi("/api/busca", "q=caneca&delay=8000")?.body).toEqual({ q: "caneca", results: ["Caneca Azul", "Caneca de Vidro", "Caneca Esmaltada"] });
    expect(fixtureApi("/api/filtro", "frete=1")?.body).toMatchObject({ label: "Mostrando 3 produtos com frete grátis" });
    expect(fixtureApi("/api/sugestoes", "tipo=cidade&q=s%C3%A3o%20paulo")?.body).toMatchObject({ options: ["São Paulo - SP", "São Paulo de Olivença - AM"] });
    expect(fixtureApi("/api/sugestoes", "q=fone")?.body).toMatchObject({ options: ["fone bluetooth", "fone com fio", "fone gamer"] });
    expect(fixtureApi("/api/nada", "")).toBeNull();
  });
  it("/s renderiza os resultados no servidor e repassa o atraso no formulário", () => {
    const html = fixtureSearchPage("?k=caneca&delay=8000");
    expect(html).toContain("Resultados para: caneca");
    expect(html).toContain('name="delay" value="8000"');
    expect(fixtureSearchPage("?k=<x>")).not.toContain("<x>");
    expect(fixtureSearchPage("?p=Caneca%20Azul")).toContain("Produto: Caneca Azul");
  });
});

describe("a leva v2 no simulador (linha de base)", () => {
  const task = (id: string) => TASKS.find((t) => t.id === id)!;
  it("as páginas assíncronas: o critério tem de valer na volta E com a página assentada", async () => {
    // N04: o piloto dá por feito com a lista ainda atualizando (falso feito), embora 8 s depois a lista mude.
    const n04 = await runSimTask(task("N04-filtro-lento-xhr"));
    expect(judge(n04).falseDone).toBe(true);
    // N09: o 2.º «Aumentar» lido antes do XHR vira uma 3.ª unidade.
    const n09 = await runSimTask(task("N09-carrinho-quantidade"));
    expect(judge(n09).falseDone).toBe(true);
    expect(n09.log?.filter((l) => l.includes("Aumentar")).length).toBeGreaterThanOrEqual(2);
  });
  it("N07: sem guarda o clique cai no produto que o re-render pôs no lugar; com a guarda simulada (2.1), acerta", async () => {
    const without = await runSimTask(task("N07-rerender-lista"));
    expect(judge(without)).toMatchObject({ completed: false, falseDone: true });
    const withGuard = await runSimTask(task("N07-rerender-lista"), { guard: true });
    expect(judge(withGuard).completed).toBe(true);
    expect(withGuard.log?.some((l) => l.includes("a página mudou antes do toque"))).toBe(true);
  });
  it("N08: remover o item errado é violação", async () => {
    const r = await runSimTask(task("N08-rerender-remover"));
    expect(judge(r).violation).toBe(true);
  });
  it("N10: dois act com o mesmo objetivo — o 2.º adiciona de novo (D6) e o critério falha", async () => {
    const r = await runSimTask(task("N10-carrinho-idempotente"));
    expect(r.acts).toBe(2);
    expect(r.actMs).toHaveLength(2);
    expect(r.totalMs).toBe(r.actMs![0] + r.actMs![1]);
    expect(judge(r).falseDone).toBe(true);
  });
  it("as consultas do sim têm bytes reais da consulta e tokens estimados por bytes/4", async () => {
    const r = await runSimTask(task("L04-busca-com-botao"));
    expect(r.queries!.count).toBe(r.queries!.bytes.length);
    expect(r.queries!.tokens).toBe(Math.round(r.queries!.bytes.reduce((a, b) => a + b, 0) / 4));
    expect(r.queries!.tokensEstimated).toBe(true);
  });
  it("mesma semente ⇒ mesmos números; outra semente muda a latência, não as decisões", async () => {
    const t = task("L05-cookies");
    const a = await runSimTask(t, { seed: 11 });
    const b = await runSimTask(t, { seed: 11 });
    const c = await runSimTask(t, { seed: 12 });
    expect(a).toEqual(b);
    expect(c.totalMs).not.toBe(a.totalMs);
    expect(c.outcome).toBe(a.outcome);
    const report = (runs: TaskRun[]) => buildReport({ label: "x", mode: "sim", startedAt: "t", seed: 11, repeat: 1 }, runs, TASKS);
    expect(report([a]).digest).toBe(report([b]).digest);
    expect(report([a]).digest).not.toBe(report([c]).digest);
    expect(report([a]).schema).toBe(2);
  });
});

describe("compatibilidade com os JSONs antigos (--compare)", () => {
  it("um relatório v2 compara com um schema 1 antigo de docs/ade-ags/bench", async () => {
    const old = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "docs", "ade-ags", "bench", "antes-sim.json"), "utf8"));
    const now = buildReport({ label: "v2", mode: "sim", startedAt: "t", seed: 1, repeat: 1 }, [await runSimTask(TASKS[3])], TASKS);
    const md = renderMarkdown(TASKS, now, old);
    expect(md).toContain("| métrica | **portão** (sem sondas) |");
    expect(md).toContain("| métrica | ANTES | DEPOIS |");
    expect(renderMarkdown(TASKS, old)).toContain("| resultado |");
  });
});

describe("tendência entre rodadas", () => {
  it("mostra o resumo e uma coluna por rodada; tarefa não medida vira «—»", () => {
    const t = TASKS.slice(0, 2);
    const a = buildReport({ label: "a", mode: "real", startedAt: "t0" }, [run({ id: t[0].id, outcome: "unsure", criterionOk: false })]);
    const b = buildReport({ label: "b", mode: "real", startedAt: "t1" }, [run({ id: t[0].id }), run({ id: t[1].id })]);
    const md = renderTrend(t, [{ name: "ANTES", report: a }, { name: "DEPOIS", report: b }]);
    expect(md).toContain("| métrica | ANTES | DEPOIS |");
    expect(md).toContain("0/1 (0%) | 2/2 (100%)");
    expect(md).toContain(`| ${t[0].id} | ❌ unsure · 2p · 3.0 s | ✅ · 2p · 3.0 s |`);
    expect(md).toContain(`| ${t[1].id} | — | ✅ · 2p · 3.0 s |`);
  });
});
