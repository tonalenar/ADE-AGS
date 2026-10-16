import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildStep, parseSnapshot, repeatedAdd, runPilot, type Done, type PilotDeps, type PriorAction, type StepQuery, type StepReply,
} from "../jevPilot";

// Plano v2, 4.1 (achado D1): as regras do NEXT_ACTION vivem em `decisions/browse_rules.rs`, uma por regra, e cada uma tem aqui
// a página que a exige. O texto da regra é para o Jev; o que se testa é o SINAL que ele cita e o comportamento do piloto.

const RULES_RS = readFileSync(new URL("../../../../src-tauri/src/decisions/browse_rules.rs", import.meta.url), "utf8");

const page = (lines: string[], url = "http://loja.test/lista") =>
  parseSnapshot(['page: "Loja" ' + url, "viewport: 1280×800 · scroll 0/800", "", ...lines].join("\n"));

const labelsOf = (query: StepQuery, operation = "click") => (query.targets[operation] ?? []).map((o) => `${o.id}: ${o.label}`);

describe("o contrato entre as regras (Rust) e os sinais do piloto (TypeScript)", () => {
  it("as palavras que as regras citam são as que o piloto escreve", () => {
    for (const signal of ["[sponsored]", "[earlier run", "[required]"]) expect(RULES_RS).toContain(signal);
    const query = buildStep(page(['- link "Anúncio" [ref=e1] [patrocinado]', '- textbox "Nome" [ref=e2] [required] value=""']), "x", ["nome"], [{ what: "[earlier run #1] antes", changed: true, earlier: true }]);
    expect(labelsOf(query)[0]).toContain("[sponsored]");
    expect(labelsOf(query, "type")[0]).toContain("[required]");
    expect(query.state).toContain("[earlier run #1]");
  });

  it("todas as regras do plano têm id e uma página de teste neste arquivo", () => {
    for (const id of ["anuncios", "passo-satisfeito", "quantidade", "paginacao", "modal-cookie", "formulario-obrigatorio"]) {
      expect(RULES_RS).toContain(`id: "${id}"`);
      expect(readFileSync(new URL(import.meta.url), "utf8")).toContain(`regra «${id}»`);
    }
  });
});

describe("regra «anuncios»", () => {
  const many = (ads: boolean) => [
    ...Array.from({ length: 130 }, (_, i) => `- link "Fone organico ${i}" [ref=e${i + 1}] → /p/${i}`),
    `- link "Fone patrocinado top" [ref=e500] [patrocinado] → /ad`,
    ...(ads ? [] : []),
  ];

  it("o anúncio leva o sinal [sponsored] e o orgânico não", () => {
    const query = buildStep(page(['- link "Fone A" [ref=e1] [patrocinado] → /a', '- link "Fone B" [ref=e2] → /b']), "abrir o primeiro fone", [], []);
    const [ad, organic] = labelsOf(query);
    expect(ad).toContain("[sponsored]");
    expect(organic).not.toContain("[sponsored]");
  });

  it("numa página comprida o anúncio é o primeiro a sair do corte, a menos que o objetivo peça anúncio", () => {
    const snapshot = page(many(false));
    const organic = buildStep(snapshot, "abrir o fone top", [], []);
    expect(labelsOf(organic).some((l) => l.startsWith("e500:"))).toBe(false);
    const wantsAd = buildStep(snapshot, "abrir o anúncio fone top", [], []);
    expect(labelsOf(wantsAd).some((l) => l.startsWith("e500:"))).toBe(true);
  });
});

/** Um portal de mentira: `pages[i]` é a página depois de i ações; clicar avança. */
function portal(script: StepReply[], pages: string[], prior?: PriorAction[]) {
  const calls: string[] = [];
  const asked: StepQuery[] = [];
  let at = 0;
  let pick = 0;
  const deps: PilotDeps = {
    prior: prior && (() => prior),
    snapshot: async () => pages[Math.min(at, pages.length - 1)],
    click: async (ref) => { calls.push(`click ${ref}`); at++; },
    type: async () => { at++; }, select: async () => { at++; }, scroll: async () => { at++; },
    settle: async () => undefined,
    pick: async (query) => { asked.push(query); return script[Math.min(pick++, script.length - 1)]; },
  };
  return { deps, calls, asked };
}

const ok = (operation: string, target: string | null = null, goalDone: number | null = null): StepReply =>
  ({ status: "ok", operation, target, probability: 0.9, goalDone, reason: null, latencyMs: 300 });

/** Uma ação de um act anterior como a ponte (portalLedger.ts) a entrega. */
const before = (over: Partial<PriorAction> = {}): PriorAction => ({
  what: '[feito num act anterior #1 "adicionar o fone"] clicou button "Adicionar"', changed: true, previous: true, actNo: 1, goal: "adicionar o fone",
  cartBefore: null, cartAfter: null, pageChangedSince: false, ...over,
});

const SHOP = (cart: number) => [
  'page: "Loja" http://loja.test/fone', "viewport: 1280×800 · scroll 0/800", "",
  '- heading "Fone X"', '- text "R$ 99"', '- button "Adicionar" [ref=e1]', `- text "Carrinho: ${cart} itens"`,
].join("\n");

describe("regra «passo-satisfeito»", () => {
  it("o que os act anteriores fizeram entra no estado como [earlier run #N], com a contagem do carrinho que a ponte trouxe", async () => {
    const prior = before({ what: '[feito num act anterior #2 "adicionar o fone"] clicou button "Adicionar" — carrinho 0→1', cartBefore: 0, cartAfter: 1 });
    const h = portal([ok("done")], [SHOP(1)], [prior]);
    await runPilot("ver o carrinho", [], undefined, h.deps);
    expect(h.asked[0].state).toContain('[earlier run #2 "adicionar o fone"] clicou button "Adicionar" — carrinho 0→1');
    expect(h.asked[0].state).not.toContain("feito num act anterior");
  });

  it("se a página mudou desde o fim do act anterior (outra navegação, outra tarefa), o histórico de antes NÃO entra no estado", async () => {
    // Benchmark real: L17/L08/L13 davam o objetivo por feito no passo 1 por causa de um «clicou Adicionar» de outra tarefa.
    const stale = before({ pageChangedSince: true, cartBefore: 0, cartAfter: 1 });
    const h = portal([ok("done")], [SHOP(0)], [stale]);
    await runPilot("ver o carrinho", [], undefined, h.deps);
    expect(h.asked[0].state).not.toContain("earlier run");
    expect(h.asked[0].state).not.toContain("RECENT ACTIONS");
  });

  it("sem livro-razão (ou se ele falha) o act segue como antes", async () => {
    const h = portal([ok("done")], [SHOP(1)]);
    expect((await runPilot("ver o carrinho", [], undefined, h.deps)).outcome).toBe("done");
    const broken = portal([ok("done")], [SHOP(1)]);
    broken.deps.prior = () => { throw new Error("sem ledger"); };
    expect((await runPilot("ver o carrinho", [], undefined, broken.deps)).outcome).toBe("done");
  });

  it("pede o livro-razão DEPOIS da primeira leitura da página", async () => {
    const order: string[] = [];
    const h = portal([ok("done")], [SHOP(1)]);
    const snapshot = h.deps.snapshot;
    h.deps.snapshot = async () => { order.push("snapshot"); return snapshot(); };
    h.deps.prior = () => { order.push("prior"); return []; };
    await runPilot("ver o carrinho", [], undefined, h.deps);
    expect(order.slice(0, 2)).toEqual(["snapshot", "prior"]);
  });
});

describe("«acabou» no primeiro passo", () => {
  it("sem nenhuma ação e com p baixa não vira FEITO: devolve a página (L17, p=0,43)", async () => {
    const h = portal([{ ...ok("done"), probability: 0.43 }], [SHOP(0)]);
    const result = await runPilot("adicionar o fone", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(result.steps.join("\n")).toContain("antes de qualquer ação");
  });

  it("com certeza (a página já cumpre o objetivo) conclui como sempre", async () => {
    const h = portal([{ ...ok("done"), probability: 0.9 }], [SHOP(1)]);
    expect((await runPilot("ver o carrinho", [], undefined, h.deps)).outcome).toBe("done");
  });
});

describe("controle coberto por uma faixa", () => {
  const COOKIES = [
    'page: "Loja" http://loja.test/c', "viewport: 1280×800 · scroll 0/800", "",
    '- button "Adicionar ao carrinho" [ref=e1]', '- button "Aceitar todos" [ref=e2]',
  ].join(String.fromCharCode(10));
  const run = async (choices: string[]) => {
    const calls: string[] = [];
    let at = 0;
    let pick = 0;
    const deps: PilotDeps = {
      snapshot: async () => COOKIES + (at > 0 ? String.fromCharCode(10) + '- text "passo ' + at + '"' : ""),
      click: async (ref) => {
        calls.push(ref);
        if (ref === "e1" && !calls.includes("e2")) throw new Error("button está coberto por div#banner (#banner)");
        at++;
      },
      type: async () => undefined, select: async () => undefined, scroll: async () => undefined, settle: async () => undefined,
      pick: async () => (choices[Math.min(pick++, choices.length - 1)] === "done" ? ok("done") : ok("click", choices[Math.min(pick - 1, choices.length - 1)])),
    };
    const result = await runPilot("adicionar a mochila", [], undefined, deps);
    return { calls, result };
  };

  it("o Jev que repete o controle coberto UMA vez ainda tem a chance de ver a falha e fechar a faixa (L05)", async () => {
    const { calls, result } = await run(["e1", "e1", "e2", "done"]);
    expect(calls).toEqual(["e1", "e1", "e2"]);
    expect(result.outcome).toBe("done");
  });

  it("…mas na segunda repetição o piloto para em vez de girar em círculos", async () => {
    const { calls, result } = await run(["e1", "e1", "e1", "e1"]);
    expect(calls).toEqual(["e1", "e1"]);
    expect(result.outcome).toBe("stuck");
  });
});

describe("regra «quantidade»", () => {
  it("o carrinho subiu na primeira vez: o segundo «adicionar» do mesmo item é recusado, sem clicar", async () => {
    // pág. 0 carrinho 0 → clique → pág. 1 carrinho 1; o Jev insiste no mesmo botão; depois conclui.
    const h = portal([ok("click", "e1"), ok("click", "e1"), ok("done")], [SHOP(0), SHOP(1)]);
    const result = await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual(["click e1"]);
    expect(result.steps.join("\n")).toContain("recusou");
    expect(result.steps.join("\n")).toContain("o carrinho subiu de 0 para 1");
    expect(result.outcome).toBe("done");
    // o Jev lê o motivo no histórico antes de escolher de novo
    expect(h.asked[2].state).toContain("não clicou");
  });

  it("um «adicionar» de um act anterior que subiu o carrinho não se repete (o caso T5)", async () => {
    const h = portal([ok("click", "e1"), ok("done")], [SHOP(1)], [before({ cartBefore: 0, cartAfter: 1 })]);
    const result = await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual([]);
    expect(result.steps.join("\n")).toContain("num act anterior");
  });

  it("…ou cuja página é a mesma do fim daquele act", async () => {
    const h = portal([ok("click", "e1"), ok("done")], [SHOP(0)], [before({ pageChangedSince: false })]);
    await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual([]);
  });

  it("numa página nova (o carrinho voltou a 0) o «adicionar» de um act anterior vale de novo (L07/L17, 2.ª repetição)", async () => {
    const h = portal([ok("click", "e1"), ok("done")], [SHOP(0)], [before({ pageChangedSince: true, cartBefore: 0, cartAfter: 1 })]);
    await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual(["click e1"]);
  });

  it("sem prova (a página mudou desde então e o carrinho não se sabe), o piloto adiciona", async () => {
    const h = portal([ok("click", "e1"), ok("done")], [SHOP(0)], [before({ pageChangedSince: true })]);
    await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual(["click e1"]);
  });

  it("vários «Adicionar» iguais na página: o do act anterior pode ser de outro item, então não recusa", async () => {
    const twins = [
      'page: "Loja" http://loja.test/lista', "viewport: 1280×800 · scroll 0/800", "",
      '- heading "Fone A"', '- button "Adicionar" [ref=e1]', '- heading "Fone B"', '- button "Adicionar" [ref=e2]',
    ].join("\n");
    const h = portal([ok("click", "e2"), ok("done")], [twins], [before({ cartBefore: 0, cartAfter: 1 })]);
    await runPilot("adicionar o fone B ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual(["click e2"]);
  });

  it("um objetivo que pede duas unidades deixa adicionar de novo", async () => {
    const h = portal([ok("click", "e1"), ok("click", "e1"), ok("done")], [SHOP(0), SHOP(1), SHOP(2)]);
    await runPilot("adicionar 2 unidades do fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual(["click e1", "click e1"]);
  });

  it("sem prova (a primeira não subiu o carrinho e é do mesmo act), o piloto não recusa", () => {
    const p = page(['- heading "Fone X"', '- button "Adicionar" [ref=e1]']);
    const history: Done[] = [{ what: "x", changed: false, add: { key: "button \"Adicionar\"|Fone X|http://loja.test/lista", cartBefore: 1, cartAfter: 1 } }];
    expect(repeatedAdd(p.elements[0], p, "adicionar o fone", history)).toBeNull();
  });

  it("insistir três vezes devolve a página a quem pediu", async () => {
    const h = portal([ok("click", "e1"), ok("click", "e1"), ok("click", "e1"), ok("click", "e1")], [SHOP(0), SHOP(1)]);
    const result = await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(h.calls).toEqual(["click e1"]);
  });
});

describe("regra «paginacao»", () => {
  it("o «Próxima página» sobrevive ao corte de uma lista comprida", () => {
    const lines = [
      ...Array.from({ length: 140 }, (_, i) => `- link "Produto ${i}" [ref=e${i + 1}] → /p/${i}`),
      '- link "Próxima página" [ref=e900] → /lista?p=2',
    ];
    const query = buildStep(page(lines), "achar o produto 777", [], []);
    expect(labelsOf(query).length).toBe(100);
    expect(labelsOf(query).some((l) => l.startsWith("e900:"))).toBe(true);
  });
});

describe("regra «modal-cookie»", () => {
  it("o «Rejeitar» da faixa de cookies sobrevive ao corte de uma página comprida", () => {
    const lines = [
      ...Array.from({ length: 140 }, (_, i) => `- button "Comprar item ${i}" [ref=e${i + 1}]`).map((l) => l.replace("Comprar", "Ver")),
      '- button "Rejeitar" [ref=e901]',
    ];
    const query = buildStep(page(lines), "abrir o item 777", [], []);
    expect(labelsOf(query).some((l) => l.startsWith("e901:"))).toBe(true);
  });
});

describe("regra «formulario-obrigatorio»", () => {
  it("o campo obrigatório vazio leva [required] e [empty]; o botão de enviar fica à vista", () => {
    const query = buildStep(
      page(['- textbox "Nome" [ref=e1] [required] value=""', '- textbox "Apelido" [ref=e2] value=""', '- button "Enviar" [ref=e3]']),
      "enviar o formulário com o nome Ana", ["nome"], [],
    );
    const fields = labelsOf(query, "type");
    expect(fields[0]).toContain("[required]");
    expect(fields[0]).toContain("empty");
    expect(fields[1]).not.toContain("[required]");
    expect(labelsOf(query).some((l) => l.includes("Enviar"))).toBe(true);
  });
});
