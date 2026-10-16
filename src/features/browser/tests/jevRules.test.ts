import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildStep, parseSnapshot, repeatedAdd, runPilot, type Done, type Ledger, type PilotDeps, type StepQuery, type StepReply,
} from "../jevPilot";

// Plano v2, 4.1 (achado D1): as regras do NEXT_ACTION vivem em `decisions/browse_rules.rs`, uma por regra, e cada uma tem aqui
// a página que a exige. O texto da regra é para o Jev; o que se testa é o SINAL que ele cita e o comportamento do piloto.

const RULES_RS = readFileSync(new URL("../../../../src-tauri/src/decisions/browse_rules.rs", import.meta.url), "utf8");

const page = (lines: string[], url = "http://loja.test/lista") =>
  parseSnapshot(['page: "Loja" ' + url, "viewport: 1280×800 · scroll 0/800", "", ...lines].join("\n"));

const labelsOf = (query: StepQuery, operation = "click") => (query.targets[operation] ?? []).map((o) => `${o.id}: ${o.label}`);

describe("o contrato entre as regras (Rust) e os sinais do piloto (TypeScript)", () => {
  it("as palavras que as regras citam são as que o piloto escreve", () => {
    for (const signal of ["[sponsored]", "[earlier run]", "[required]"]) expect(RULES_RS).toContain(signal);
    const query = buildStep(page(['- link "Anúncio" [ref=e1] [patrocinado]', '- textbox "Nome" [ref=e2] [required] value=""']), "x", ["nome"], [{ what: "antes", changed: true, earlier: true }]);
    expect(labelsOf(query)[0]).toContain("[sponsored]");
    expect(labelsOf(query, "type")[0]).toContain("[required]");
    expect(query.state).toContain("[earlier run]");
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
function portal(script: StepReply[], pages: string[], ledger?: Ledger) {
  const calls: string[] = [];
  const asked: StepQuery[] = [];
  let at = 0;
  let pick = 0;
  const deps: PilotDeps = {
    ledger,
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

const SHOP = (cart: number) => [
  'page: "Loja" http://loja.test/fone', "viewport: 1280×800 · scroll 0/800", "",
  '- heading "Fone X"', '- text "R$ 99"', '- button "Adicionar" [ref=e1]', `- text "Carrinho: ${cart} itens"`,
].join("\n");

describe("regra «passo-satisfeito»", () => {
  it("o que os act anteriores fizeram entra no estado como [earlier run], e o que este fez é gravado sem a marca", async () => {
    let saved: Done[] = [];
    const ledger: Ledger = { load: () => [{ what: 'clicou button "Adicionar"', changed: true }], save: (entries) => { saved = entries; } };
    const h = portal([ok("done")], [SHOP(1)], ledger);
    await runPilot("ver o carrinho", [], undefined, h.deps);
    expect(h.asked[0].state).toContain('clicou button "Adicionar" [earlier run]');
    expect(saved.length).toBe(1);
    expect(saved[0]).not.toHaveProperty("earlier");
  });

  it("grava o livro-razão mesmo quando o act falha no meio", async () => {
    let saved: Done[] | null = null;
    const ledger: Ledger = { load: () => [], save: (entries) => { saved = entries; } };
    const h = portal([ok("click", "e1")], [SHOP(0)], ledger);
    h.deps.settle = async () => { throw new Error("a janela não respondeu"); };
    const result = await runPilot("adicionar o fone ao carrinho", [], undefined, h.deps);
    expect(result.outcome).toBe("error");
    expect(saved).not.toBeNull();
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

  it("um «adicionar» de um act anterior que mudou a página também não se repete", async () => {
    const earlier: Done = { what: 'clicou button "Adicionar"', changed: true, add: { key: 'button "Adicionar"|Fone X | R$ 99|http://loja.test/fone', cartBefore: null, cartAfter: null } };
    const ledger: Ledger = { load: () => [earlier], save: () => undefined };
    const h = portal([ok("click", "e1"), ok("done")], [SHOP(0)], ledger);
    await runPilot("adicionar o fone X ao carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual([]);
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
