import { describe, expect, it } from "vitest";

import {
  MAX_PER_HEAD, MIN_PROBABILITY, bareUrl, buildStep, fingerprint, formatResult, parseFills, parseSnapshot, runPilot, valueFor,
  type PilotDeps, type StepQuery, type StepReply,
} from "../jevPilot";

const LOGIN = [
  'page: "Entrar — Loja" http://localhost:5173/login?token=segredo#x',
  "viewport: 1280×800 · scroll 0/800",
  "",
  '- heading "Bem-vindo"',
  '- text "Entre na sua conta"',
  '- textbox "E-mail" [ref=e1] value=""',
  '- textbox "Senha" [ref=e2] value="[x]"',
  '- checkbox "Lembrar de mim" [ref=e3] [checked]',
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
    expect(page.elements[2].states).toEqual(["checked"]);
    expect(page.text).toEqual(["Entre na sua conta"]);
  });

  it("sabe se um campo tem valor, sem nunca ler o valor", () => {
    const page = parseSnapshot(LOGIN);
    expect(page.elements[0].filled).toBe(false);
    expect(page.elements[1].filled).toBe(true);
    expect(page.elements[3].filled).toBeNull(); // um botão não tem valor
    expect(JSON.stringify(page)).not.toContain("[x]");
  });

  it("o endereço vai sem consulta nem fragmento", () => {
    expect(bareUrl("http://localhost:5173/login?token=segredo#x")).toBe("http://localhost:5173/login");
  });

  it("a impressão da página muda quando um campo é preenchido", () => {
    const before = parseSnapshot(LOGIN);
    const after = parseSnapshot(LOGIN.replace('[ref=e1] value=""', '[ref=e1] value="a"'));
    expect(fingerprint(before)).not.toBe(fingerprint(after));
    expect(fingerprint(before)).toBe(fingerprint(parseSnapshot(LOGIN)));
  });
});

describe("a consulta de cada passo", () => {
  const page = parseSnapshot(LOGIN);
  const ids = (list: { id: string }[] | undefined) => (list ?? []).map((o) => o.id);

  it("separa os elementos por operação e nunca oferece o desabilitado", () => {
    const query = buildStep(page, "entrar na conta", ["email", "senha"], []);
    expect(ids(query.targets.click)).toEqual(["e3", "e4", "e6"]);
    expect(ids(query.targets.type)).toEqual(["e1", "e2"]);
    expect(ids(query.operations)).toEqual(["click", "type", "scroll", "wait", "done", "stuck"]);
  });

  it("digitar e escolher numa lista só são operações se ainda sobra um --fill", () => {
    const none = buildStep(page, "entrar", [], []);
    expect(ids(none.operations)).not.toContain("type");
    expect(none.targets.type).toBeUndefined();
  });

  it("a operação wait some depois de duas esperas seguidas", () => {
    expect(ids(buildStep(page, "x", [], [], 2).operations)).not.toContain("wait");
  });

  it("cada cabeça de alvo leva no máximo MAX_PER_HEAD elementos, os mais ligados ao objetivo", () => {
    const many = ['page: "x" http://a.test/'];
    for (let i = 1; i <= 100; i++) many.push(`- button "Item ${i}" [ref=e${i}]`);
    many.push('- button "Finalizar compra" [ref=e101]');
    const query = buildStep(parseSnapshot(many.join("\n")), "finalizar a compra", [], []);
    expect(query.targets.click.length).toBe(MAX_PER_HEAD);
    expect(ids(query.targets.click)).toContain("e101");
  });

  it("o estado lista os elementos da página, para a pergunta da operação também os ver", () => {
    const { state } = buildStep(page, "entrar", [], []);
    expect(state).toContain("ELEMENTS ON THE PAGE:");
    expect(state).toContain('[e4] button "Entrar"');
    expect(state).not.toContain("e5"); // o desabilitado fica de fora
  });

  it("um link sem nome é identificado para onde vai (o ícone do carrinho), sem consulta nem fragmento", () => {
    const shop = parseSnapshot(['page: "Loja" http://shop.test/inventory.html', '- link [ref=e1] → /cart.html?session=abc#x', '- button "Add to cart" [ref=e2]'].join("\n"));
    const query = buildStep(shop, "abrir o carrinho", [], []);
    const label = query.targets.click.find((o) => o.id === "e1")?.label;
    expect(label).toBe("link → /cart.html");
    expect(query.state).not.toContain("session=abc");
  });

  it("os rótulos mostram o estado, nunca o valor", () => {
    const query = buildStep(page, "entrar", ["email"], []);
    const label = (ref: string) => query.targets.click?.concat(query.targets.type ?? []).find((o) => o.id === ref)?.label;
    expect(label("e1")).toBe('text field "E-mail" (empty)');
    expect(label("e2")).toBe('text field "Senha" (filled)');
    expect(label("e3")).toBe('checkbox "Lembrar de mim" (checked)');
    expect(query.targets.click.find((o) => o.id === "e6")?.label).toBe('link "Esqueci a senha" → /reset');
  });

  it("o estado leva o objetivo, os NOMES dos campos e as últimas ações, nunca valores nem a consulta do endereço", () => {
    const { state } = buildStep(page, "entrar", ["email", "senha"], [
      { what: 'digitou em text field "E-mail" (valor de email)', changed: true },
      { what: 'clicou button "Entrar"', changed: false },
    ]);
    expect(state).toContain("GOAL: entrar");
    expect(state).toContain("email, senha");
    expect(state).toContain('1. digitou em text field "E-mail" (valor de email) → the page changed');
    expect(state).toContain('2. clicou button "Entrar" → the page did not change');
    expect(state).not.toContain("segredo");
    expect(state).toContain("Entre na sua conta");
  });

  it("repetir um botão em outra página é legítimo: o que já foi feito não esconde elementos", () => {
    const query = buildStep(page, "entrar", [], [{ what: 'clicou button "Entrar"', changed: true }]);
    expect(ids(query.targets.click)).toContain("e4");
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
  const asked: StepQuery[] = [];
  const deps: PilotDeps = {
    snapshot: async () => pages[Math.min(page, pages.length - 1)],
    click: async (ref) => { calls.push(`click ${ref}`); page++; },
    type: async (ref, text) => { calls.push(`type ${ref} ${text}`); page++; },
    select: async (ref, value) => { calls.push(`select ${ref} ${value}`); page++; },
    scroll: async () => { calls.push("scroll"); page++; },
    settle: async () => undefined,
    pick: async (query) => { asked.push(query); return script[Math.min(pick++, script.length - 1)]; },
  };
  return { deps, calls, asked };
}

const ok = (operation: string, target: string | null = null, probability = 0.9): StepReply =>
  ({ status: "ok", operation, target, probability, reason: null, latencyMs: 300 });

describe("o laço do piloto", () => {
  it("digita com o valor do --fill (sem o Jev), clica no que o Jev escolhe e termina no done", async () => {
    const h = harness([ok("click", "e4"), ok("done")]);
    const result = await runPilot("entrar", ["email=a@b.c", "senha=123"], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.calls).toEqual(["type e1 a@b.c", "type e2 123", "click e4"]);
    // o valor nunca vai no relato nem na pergunta ao provedor
    expect(result.steps.join("\n")).not.toContain("123");
    expect(result.steps.join("\n")).not.toContain("a@b.c");
    expect(h.asked.every((q) => !q.state.includes("123") && !q.state.includes("a@b.c"))).toBe(true);
    // o Jev só foi consultado depois dos campos, e para o que é escolha
    expect(h.asked.length).toBe(2);
    expect(result.steps[0]).toContain("sem o Jev");
    // a segunda consulta já traz o que foi feito e se a página mudou
    expect(h.asked[1].state).toContain("RECENT ACTIONS");
    expect(h.asked[1].state).toContain("clicou button \"Entrar\"");
  });

  it("os campos com --fill não gastam passo nem pergunta: o limite é só das escolhas do Jev", async () => {
    const h = harness([ok("click", "e4")]);
    const result = await runPilot("entrar", ["email=a@b.c", "senha=123"], 1, h.deps);
    expect(h.calls.slice(0, 2)).toEqual(["type e1 a@b.c", "type e2 123"]);
    expect(h.asked.length).toBe(1);
    expect(result.outcome).toBe("limit");
  });

  it("um --fill sem campo parecido não digita em outro: fica para o Jev ou o agente", async () => {
    const h = harness([ok("stuck")]);
    await runPilot("entrar", ["cpf=000"], undefined, h.deps);
    expect(h.calls).toEqual([]);
  });

  it("o Jev escolhendo digitar num campo sem valor falha dizendo qual --fill falta", async () => {
    // Dois valores e nenhum parecido com o campo: não adivinha qual vai onde.
    const h = harness([ok("type", "e1")]);
    const result = await runPilot("entrar", ["cpf=000", "cep=111"], undefined, h.deps);
    expect(result.outcome).toBe("error");
    expect(result.steps.join("\n")).toContain("--fill");
    expect(h.calls).toEqual([]);
  });

  it("sem certeza (probabilidade baixa), para sem agir e devolve a página", async () => {
    const h = harness([ok("click", "e4", MIN_PROBABILITY - 0.1)]);
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(h.calls).toEqual([]);
    expect(formatResult("entrar", result)).toContain("Entrar — Loja");
  });

  it("Jev desligado: não age e conta por quê", async () => {
    const h = harness([{ status: "off", operation: null, target: null, probability: null, reason: "O Jev não está pilotando navegadores.", latencyMs: null }]);
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("off");
    expect(result.note).toContain("pilotando");
    expect(h.calls).toEqual([]);
  });

  it("a mesma operação no mesmo elemento da mesma página duas vezes seguidas é um círculo: para", async () => {
    const same = Array.from({ length: 4 }, () => LOGIN);
    const h = harness([ok("scroll"), ok("scroll")], same);
    const result = await runPilot("achar algo", [], undefined, h.deps);
    expect(result.outcome).toBe("stuck");
    expect(h.calls).toEqual(["scroll"]);
  });

  it("wait espera a página e segue; depois de duas esperas seguidas deixa de ser oferecido", async () => {
    const h = harness([ok("wait"), ok("wait"), ok("done")]);
    const result = await runPilot("achar algo", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.calls).toEqual([]);
    expect(h.asked[2].operations.map((o) => o.id)).not.toContain("wait");
  });

  it("respeita o limite de passos", async () => {
    const h = harness([ok("click", "e6"), ok("click", "e3"), ok("click", "e4")]);
    const result = await runPilot("entrar", [], 2, h.deps);
    expect(result.outcome).toBe("limit");
    expect(h.calls.length).toBe(2);
  });

  it("stuck do Jev encerra sem agir", async () => {
    const result = await runPilot("voar", [], undefined, harness([ok("stuck")]).deps);
    expect(result.outcome).toBe("stuck");
  });
});
