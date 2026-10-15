import { describe, expect, it } from "vitest";

import {
  MAX_ELEMENTS, MIN_PROBABILITY, bareUrl, buildStep, formatResult, parseFills, parseSnapshot, runPilot, valueFor,
  type PilotDeps, type StepOption, type StepReply,
} from "../jevPilot";

const LOGIN = [
  'page: "Entrar — Loja" http://localhost:5173/login?token=segredo#x',
  "viewport: 1280×800 · scroll 0/800",
  "",
  '- heading "Bem-vindo"',
  '- text "Entre na sua conta"',
  '- textbox "E-mail" [ref=e1]',
  '- textbox "Senha" [ref=e2] value="[x]"',
  '- checkbox "Lembrar de mim" [ref=e3]',
  '- button "Entrar" [ref=e4]',
  '- button "Cancelar" [ref=e5] [disabled]',
  '- link "Esqueci a senha" [ref=e6] → /reset',
].join("\n");

describe("leitura do snapshot", () => {
  it("separa título, endereço, elementos tocáveis e texto", () => {
    const page = parseSnapshot(LOGIN);
    expect(page.title).toBe("Entrar — Loja");
    expect(page.url).toContain("localhost:5173/login");
    expect(page.elements.map((e) => e.ref)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(page.elements[4].states).toEqual(["disabled"]);
    expect(page.elements[1].states).toEqual([]); // o `[x]` era de dentro do valor
    expect(page.text).toEqual(["Entre na sua conta"]);
  });

  it("o endereço vai sem consulta nem fragmento", () => {
    expect(bareUrl("http://localhost:5173/login?token=segredo#x")).toBe("http://localhost:5173/login");
  });
});

describe("a pergunta de cada passo", () => {
  const page = parseSnapshot(LOGIN);

  it("oferece só o que se pode tocar, mais done/scroll/stuck, e nunca o desabilitado", () => {
    const { options } = buildStep(page, "entrar na conta", ["email", "senha"], []);
    const ids = options.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["e1", "e2", "e3", "e4", "e6", "done", "scroll", "stuck"]));
    expect(ids).not.toContain("e5");
  });

  it("no máximo 19 opções, com os elementos mais ligados ao objetivo", () => {
    const many = ['page: "x" http://a.test/'];
    for (let i = 1; i <= 40; i++) many.push(`- button "Item ${i}" [ref=e${i}]`);
    many.push('- button "Finalizar compra" [ref=e41]');
    const { options } = buildStep(parseSnapshot(many.join("\n")), "finalizar a compra", [], []);
    expect(options.length).toBeLessThanOrEqual(19);
    expect(options.length).toBe(MAX_ELEMENTS + 3);
    expect(options.map((o) => o.id)).toContain("e41");
  });

  it("o estado leva o objetivo e os NOMES dos campos, nunca os valores nem a consulta do endereço", () => {
    const { state } = buildStep(page, "entrar", ["email", "senha"], [{ ref: "e1", what: 'digitou em campo de texto "E-mail"' }]);
    expect(state).toContain("OBJETIVO: entrar");
    expect(state).toContain("email, senha");
    expect(state).toContain("JÁ FEITO: 1. digitou em campo de texto");
    expect(state).not.toContain("segredo");
    expect(state).toContain("Entre na sua conta");
  });

  it("o que já foi feito não volta como opção", () => {
    const { options } = buildStep(page, "entrar", [], [{ ref: "e4", what: "clicou" }]);
    expect(options.map((o) => o.id)).not.toContain("e4");
  });
});

describe("valores de --fill", () => {
  const fills = parseFills(["email=a@b.c", "senha=x=y", "sem igual"]);
  it("separa no primeiro =", () => expect(fills).toEqual([["email", "a@b.c"], ["senha", "x=y"]]));
  it("casa o campo pelo nome parecido", () => {
    expect(valueFor("E-mail", fills, new Set())).toEqual(["email", "a@b.c"]);
    expect(valueFor("Senha", fills, new Set())).toEqual(["senha", "x=y"]);
  });
  it("cada valor serve a um campo só; o único que sobrou serve a qualquer um", () => {
    expect(valueFor("Campo qualquer", fills, new Set(["email"]))).toEqual(["senha", "x=y"]);
    expect(valueFor("Campo qualquer", fills, new Set())).toBeNull();
  });
});

/** Uma página por passo: cada ação avança para a próxima, e o texto muda para o laço não ver círculo. */
function pagesOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => LOGIN.replace("Bem-vindo", `Pagina ${i}`));
}

function harness(script: StepReply[], pages: string[] = pagesOf(8)) {
  const calls: string[] = [];
  let page = 0;
  let pick = 0;
  const asked: { state: string; options: StepOption[] }[] = [];
  const deps: PilotDeps = {
    snapshot: async () => pages[Math.min(page, pages.length - 1)],
    click: async (ref) => { calls.push(`click ${ref}`); page++; },
    type: async (ref, text) => { calls.push(`type ${ref} ${text}`); page++; },
    select: async (ref, value) => { calls.push(`select ${ref} ${value}`); page++; },
    scroll: async () => { calls.push("scroll"); page++; },
    settle: async () => undefined,
    pick: async (state, options) => { asked.push({ state, options }); return script[Math.min(pick++, script.length - 1)]; },
  };
  return { deps, calls, asked };
}

const ok = (choice: string, probability = 0.9): StepReply => ({ status: "ok", choice, probability, reason: null, latencyMs: 300 });

describe("o laço do piloto", () => {
  it("digita com o valor do --fill, clica e termina quando o Jev diz done", async () => {
    const h = harness([ok("e1"), ok("e2"), ok("e4"), ok("done")]);
    const result = await runPilot("entrar", ["email=a@b.c", "senha=123"], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.calls).toEqual(["type e1 a@b.c", "type e2 123", "click e4"]);
    // o valor nunca vai no relato nem na pergunta ao provedor
    expect(result.steps.join("\n")).not.toContain("123");
    expect(result.steps.join("\n")).not.toContain("a@b.c");
    expect(h.asked.every((q) => !q.state.includes("123") && !q.state.includes("a@b.c"))).toBe(true);
  });

  it("sem certeza (probabilidade baixa), para sem agir e devolve a página", async () => {
    const h = harness([ok("e4", MIN_PROBABILITY - 0.1)]);
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(h.calls).toEqual([]);
    expect(formatResult("entrar", result)).toContain("Entrar — Loja");
  });

  it("Jev desligado: não age e conta por quê", async () => {
    const h = harness([{ status: "off", choice: null, probability: null, reason: "O Jev não está pilotando navegadores.", latencyMs: null }]);
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("off");
    expect(result.note).toContain("pilotando");
    expect(h.calls).toEqual([]);
  });

  it("um campo sem valor falha dizendo qual --fill falta, sem inventar texto", async () => {
    const h = harness([ok("e1")]);
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("error");
    expect(result.steps.join("\n")).toContain("--fill");
    expect(h.calls).toEqual([]);
  });

  it("a mesma escolha na mesma página duas vezes seguidas é um círculo: para", async () => {
    const same = Array.from({ length: 4 }, () => LOGIN);
    const h = harness([ok("scroll"), ok("scroll")], same);
    const result = await runPilot("achar algo", [], undefined, h.deps);
    expect(result.outcome).toBe("stuck");
    expect(h.calls).toEqual(["scroll"]);
  });

  it("respeita o limite de passos", async () => {
    const h = harness([ok("e6"), ok("e3"), ok("e4")]);
    const result = await runPilot("entrar", [], 2, h.deps);
    expect(result.outcome).toBe("limit");
    expect(h.calls.length).toBe(2);
  });

  it("stuck do Jev encerra sem agir", async () => {
    const result = await runPilot("voar", [], undefined, harness([ok("stuck")]).deps);
    expect(result.outcome).toBe("stuck");
  });
});
