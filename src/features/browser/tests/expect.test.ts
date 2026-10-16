import { describe, expect, it } from "vitest";

import { applyVerification, checkExpectation, genericProblem, norm, parseExpectations, verify, verifyReport } from "../expect";
import { formatResult, parseSnapshot, type PilotResult } from "../jevPilot";

const snap = (url: string, lines: string[]) => ["page: \"Loja\" " + url, "viewport: 1000×600 · scroll 0/600", "", ...lines].join("\n");

const CART_ONE = snap("http://shop.test/cart", ['- heading "Seu carrinho"', '- text "1 item"', '- button "Remover Caneca Azul" [ref=e1]']);
const CART_EMPTY = snap("http://shop.test/cart", ['- heading "Seu carrinho"', '- text "Seu carrinho está vazio"']);
const ERROR = snap("http://shop.test/x", ['- heading "Algo deu errado"', '- text "Tente de novo"']);
const FORM_ERR = snap("http://shop.test/f", ['- heading "Cadastro"', '- text "Este campo é obrigatório"', '- textbox "Nome" [ref=e1] value=""']);
const NONE = snap("http://shop.test/s?q=zzz", ['- heading "Busca"', '- text "Nenhum resultado para zzz"']);

describe("--expect: leitura", () => {
  it("lê os quatro tipos, com ou sem aspas", () => {
    const { expects, errors } = parseExpectations(['text:"Seu carrinho está vazio"', "url:/cart", "count:1", "count:2@Caneca", "absent:Algo deu errado"]);
    expect(errors).toEqual([]);
    expect(expects.map((e) => [e.kind, e.value, e.n])).toEqual([
      ["text", "Seu carrinho está vazio", undefined], ["url", "/cart", undefined], ["count", "", 1], ["count", "Caneca", 2], ["absent", "Algo deu errado", undefined],
    ]);
  });

  it("recusa o que não entende, dizendo o formato", () => {
    const { expects, errors } = parseExpectations(["carrinho vazio", "count:um", "text:", "url:"]);
    expect(expects).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("text:");
  });

  it("aceita /regex/ em text e absent", () => {
    const { expects } = parseExpectations(["text:/removido: (mouse|cabo)/"]);
    expect(checkExpectation(expects[0], parseSnapshot(snap("http://a.test/", ['- text "Removido: Cabo USB"']))).ok).toBe(true);
  });

  it("ignora acento, caixa e espaços ao comparar", () => {
    expect(norm("  Seu   CARRINHO está  Vazio ")).toBe("seu carrinho esta vazio");
  });
});

describe("--expect: conferência", () => {
  const page = (s: string) => parseSnapshot(s);
  const one = (raw: string) => parseExpectations([raw]).expects[0];

  it("text: acha o texto sem ligar para acento e caixa", () => {
    expect(checkExpectation(one("text:seu carrinho esta vazio"), page(CART_EMPTY)).ok).toBe(true);
    expect(checkExpectation(one("text:Pedido enviado"), page(CART_EMPTY)).ok).toBe(false);
  });

  it("url: confere o endereço", () => {
    expect(checkExpectation(one("url:/cart"), page(CART_ONE)).ok).toBe(true);
    expect(checkExpectation(one("url:/checkout"), page(CART_ONE)).ok).toBe(false);
  });

  it("count: confere a contagem do carrinho", () => {
    expect(checkExpectation(one("count:1"), page(CART_ONE)).ok).toBe(true);
    expect(checkExpectation(one("count:2"), page(CART_ONE)).ok).toBe(false);
    expect(checkExpectation(one("count:0"), page(CART_EMPTY)).ok).toBe(true);
    expect(checkExpectation(one("count:1"), page(snap("http://a.test/", ['- text "Olá"']))).detail).toContain("não parece");
  });

  it("count:N@texto conta as ocorrências", () => {
    expect(checkExpectation(one("count:1@Caneca"), page(CART_ONE)).ok).toBe(true);
    expect(checkExpectation(one("count:2@Caneca"), page(CART_ONE)).ok).toBe(false);
  });

  it("absent: falha quando o texto aparece", () => {
    expect(checkExpectation(one("absent:Algo deu errado"), page(ERROR)).ok).toBe(false);
    expect(checkExpectation(one("absent:Algo deu errado"), page(CART_ONE)).ok).toBe(true);
  });
});

describe("veredito do act", () => {
  const verdict = (goal: string, outcome: PilotResult["outcome"], expects: string[], s: string) =>
    verify(goal, outcome, parseExpectations(expects).expects, parseSnapshot(s)).verdict;

  it("tudo confere ⇒ verificado", () => {
    expect(verdict("esvaziar o carrinho", "done", ["text:Seu carrinho está vazio", "count:0"], CART_EMPTY)).toBe("verified");
  });
  it("o piloto diz FEITO e a página desmente ⇒ NÃO CONFERE (o falso «feito» do carrinho)", () => {
    expect(verdict("deixar 1 item no carrinho", "done", ["count:2"], CART_ONE)).toBe("mismatch");
  });
  it("sem --expect e sem nada suspeito ⇒ não verificado", () => {
    expect(verdict("abrir o carrinho", "done", [], CART_ONE)).toBe("unverified");
  });
  it("página de erro, validação de formulário e «nenhum resultado» são NÃO CONFERE por padrão", () => {
    expect(verdict("adicionar ao carrinho", "done", [], ERROR)).toBe("mismatch");
    expect(verdict("enviar o cadastro", "done", [], FORM_ERR)).toBe("mismatch");
    expect(verdict("pesquisar zzz", "done", [], NONE)).toBe("mismatch");
  });
  it("o objetivo que fala do erro ou de «nenhum» silencia o verificador genérico", () => {
    expect(genericProblem("abrir a página de erro", parseSnapshot(ERROR))).toBeNull();
    expect(genericProblem("confirmar que nenhum resultado aparece", parseSnapshot(NONE))).toBeNull();
  });
  it("um rótulo «Obrigatório» num controle não é mensagem de validação", () => {
    const labelled = snap("http://a.test/", ['- textbox "Nome (campo obrigatório)" [ref=e1] value="Ana"', '- button "Enviar" [ref=e2]', '- text "Obrigado!"']);
    expect(genericProblem("enviar o cadastro", parseSnapshot(labelled))).toBeNull();
  });
  it("sem FEITO, só --expect conferindo vira verificado (falso «parou» à vista)", () => {
    expect(verdict("esvaziar o carrinho", "stuck", ["count:0"], CART_EMPTY)).toBe("verified");
  });
});

describe("relatório reescrito", () => {
  const base = (outcome: PilotResult["outcome"]) =>
    formatResult("esvaziar o carrinho", { outcome, steps: ["1. clicou Remover"], note: "O Jev considera o objetivo atingido. Confira na página abaixo.", finalSnapshot: CART_EMPTY });

  it("FEITO (verificado) com a conferência", () => {
    const out = verifyReport(base("done"), "esvaziar o carrinho", "done", ["text:Seu carrinho está vazio"], CART_EMPTY);
    expect(out.split("\n")[0]).toBe('act "esvaziar o carrinho": FEITO (verificado)');
    expect(out).toContain("✓ text:Seu carrinho está vazio");
    expect(out).toContain("A página agora");
  });

  it("NÃO CONFERE troca a 1.ª linha e manda não dar por feito", () => {
    const out = verifyReport(base("done"), "esvaziar o carrinho", "done", ["count:3"], CART_ONE);
    expect(out.split("\n")[0]).toBe('act "esvaziar o carrinho": NÃO CONFERE');
    expect(out).toContain("✗ count:3");
    expect(out).toContain("NÃO dê por feito");
  });

  it("FEITO (não verificado) com a dica de --expect em tarefa de carrinho", () => {
    const out = verifyReport(base("done"), "esvaziar o carrinho", "done", [], CART_ONE);
    expect(out.split("\n")[0]).toBe('act "esvaziar o carrinho": FEITO (não verificado)');
    expect(out).toContain("--expect");
  });

  it("um PAROU com tudo conferindo ganha a nota, sem mudar a cabeça", () => {
    const out = verifyReport(base("stuck"), "esvaziar o carrinho", "stuck", ["count:0"], CART_EMPTY);
    expect(out.split("\n")[0]).toBe('act "esvaziar o carrinho": PAROU');
    expect(out).toContain("tudo o que você esperava confere");
  });

  it("sem --expect e parou: o relatório não muda", () => {
    const r = base("stuck");
    expect(applyVerification(r, "stuck", { verdict: "unverified", lines: [] }, false)).toBe(r);
  });
});
