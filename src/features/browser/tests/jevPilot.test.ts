import { describe, expect, it } from "vitest";

import {
  MAX_PER_HEAD, MIN_PROBABILITY, words, bareUrl, buildStep, fingerprint, formatResult, parseFills, parseSnapshot, runPilot, valueFor,
  blockedPurchase, isAmbiguous, isSearchField, submitsOnType, pickText, sensitiveFilled, type PilotDeps, type StepQuery, type StepReply, type VisualReply,
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
  const navs: boolean[] = [];
  const settles: boolean[] = [];
  let page = 0;
  let pick = 0;
  const asked: StepQuery[] = [];
  const deps: PilotDeps = {
    snapshot: async () => pages[Math.min(page, pages.length - 1)],
    click: async (ref, navigates) => { calls.push(`click ${ref}`); navs.push(!!navigates); page++; },
    type: async (ref, text) => { calls.push(`type ${ref} ${text}`); page++; },
    select: async (ref, value) => { calls.push(`select ${ref} ${value}`); page++; },
    scroll: async () => { calls.push("scroll"); page++; },
    settle: async (thorough) => { settles.push(!!thorough); },
    pick: async (query) => { asked.push(query); return script[Math.min(pick++, script.length - 1)]; },
  };
  return { deps, calls, asked, navs, settles };
}

const ok = (operation: string, target: string | null = null, probability = 0.9, goalDone: number | null = null): StepReply =>
  ({ status: "ok", operation, target, probability, goalDone, reason: null, latencyMs: 300 });

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

// ── A reserva visual ────────────────────────────────────────────────

/** A mesma página, com a senha vazia: a foto só sai se nenhum campo sensível está preenchido. */
const CLEAN = LOGIN.replace('value="[x]"', 'value=""');

const seen = (center: [number, number] | null, found = true, foundProbability = 0.95, confidence = 0.8): VisualReply =>
  ({ status: "ok", found, foundProbability, center, confidence, reason: null, latencyMs: 280 });

function visualHarness(script: StepReply[], visual: VisualReply | Error, pages = pagesOf(8).map((p) => p.replace('value="[x]"', 'value=""'))) {
  const h = harness(script, pages);
  const clicks: [number, number][] = [];
  const asked: { goal: string; recent: string }[] = [];
  h.deps.visual = async (goal, recent) => {
    asked.push({ goal, recent });
    if (visual instanceof Error) throw visual;
    return visual;
  };
  h.deps.clickAt = async (x, y) => { clicks.push([x, y]); };
  return { ...h, clicks, asked };
}

describe("a reserva visual do piloto", () => {
  it("sem certeza no texto, a foto aponta o ponto e o piloto toca nele (fração × janela da página)", async () => {
    const h = visualHarness([ok("click", "e4", 0.3), ok("done")], seen([0.5, 0.25]));
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.clicks).toEqual([[640, 200]]); // janela 1280×800
    expect(result.steps.join("\n")).toContain("tocou pela foto no ponto (640, 200)");
    expect(h.asked[0].goal).toBe("abrir o carrinho");
  });

  it("o Jev dizendo stuck também tenta a foto antes de desistir", async () => {
    const h = visualHarness([ok("stuck"), ok("done")], seen([0.1, 0.1]));
    const result = await runPilot("achar o ícone", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.clicks.length).toBe(1);
  });

  it("a foto sem um controle seguro devolve a página ao agente, dizendo isso", async () => {
    for (const reply of [seen(null, false, 0.97, 0.09), seen([0.5, 0.5], true, 0.4), seen([0.5, 0.5], true, 0.95, 0.2)]) {
      const h = visualHarness([ok("click", "e4", 0.3)], reply);
      const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
      expect(result.outcome).toBe("unsure");
      expect(h.clicks).toEqual([]);
      expect(result.steps.join("\n")).toContain("também não achou");
    }
  });

  it("com um campo de senha preenchido a foto NÃO sai", async () => {
    const h = visualHarness([ok("click", "e4", 0.3)], seen([0.5, 0.25]), pagesOf(8));
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(h.asked).toEqual([]);
    expect(result.steps.join("\n")).toContain("não pode sair");
  });

  it("desligada em Ajustes, o piloto segue como antes e avisa onde ligar", async () => {
    const off: VisualReply = { status: "off", found: null, foundProbability: null, center: null, confidence: null, reason: "desligada", latencyMs: null };
    const result = await runPilot("abrir o carrinho", [], undefined, visualHarness([ok("click", "e4", 0.3)], off).deps);
    expect(result.outcome).toBe("unsure");
    expect(result.steps.join("\n")).toContain("desligada em Ajustes");
  });

  it("uma falha na foto não derruba o piloto", async () => {
    const result = await runPilot("abrir o carrinho", [], undefined, visualHarness([ok("click", "e4", 0.3)], new Error("sem rede")).deps);
    expect(result.outcome).toBe("unsure");
    expect(result.steps.join("\n")).toContain("sem rede");
  });

  it("não tira duas fotos da mesma página", async () => {
    const same = Array.from({ length: 4 }, () => CLEAN);
    const h = visualHarness([ok("click", "e4", 0.3), ok("click", "e4", 0.3)], seen(null, false), same);
    await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(h.asked.length).toBe(1);
  });

  it("sem as funções da reserva (outros navegadores), nada muda", async () => {
    const result = await runPilot("abrir o carrinho", [], undefined, harness([ok("click", "e4", 0.3)], pagesOf(4).map((p) => p.replace('value="[x]"', 'value=""'))).deps);
    expect(result.outcome).toBe("unsure");
  });
});

describe("referência velha", () => {
  it("se a página recarregou entre a leitura e o toque, relê e tenta de novo, sem desistir", async () => {
    const h = harness([ok("click", "e4"), ok("click", "e4"), ok("done")], pagesOf(10).map((p) => p.replace('value="[x]"', 'value=""')));
    let first = true;
    const realClick = h.deps.click;
    h.deps.click = async (ref) => {
      if (first) { first = false; throw new Error("Não há nenhum elemento e4: tire um novo snapshot (os refs mudam a cada um)."); }
      return realClick(ref);
    };
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(result.steps.join("\n")).toContain("li de novo");
    expect(h.calls).toEqual(["click e4"]);
  });

  it("não fica tentando para sempre: depois de duas, devolve o erro", async () => {
    const h = harness([ok("click", "e4")], pagesOf(10).map((p) => p.replace('value="[x]"', 'value=""')));
    h.deps.click = async () => { throw new Error("Não há nenhum elemento e4: tire um novo snapshot."); };
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("error");
  });
});

describe("autoFill: campo de texto antes da lista", () => {
  it("a barra de busca recebe o termo, não o seletor de departamento que tem quase o mesmo nome", async () => {
    const shop = ['page: "Amazon" https://shop.test/', "viewport: 1000×600 · scroll 0/600", "",
      '- combobox "Pesquisar em" [ref=e1] value="Todos"', '- textbox "Pesquisar Amazon.com.br" [ref=e2] value=""', '- button "Ir" [ref=e3]'].join("\n");
    const h = harness([ok("stuck")], [shop]);
    await runPilot("pesquisar", ["Pesquisa=fone"], undefined, h.deps);
    expect(h.calls[0]).toBe("type e2 fone");
  });
});

describe("elementos sem nome iguais", () => {
  const ICONS = ['page: "Loja" http://shop.test/', "viewport: 1000×600 · scroll 0/600", "", "- clickable [ref=e1]", "- clickable [ref=e2]", '- button "Login" [ref=e3]', '- link "Ajuda" [ref=e4] → /ajuda'].join("\n");

  it("dois ícones sem nome são ambíguos; os com nome, não", () => {
    const query = buildStep(parseSnapshot(ICONS), "abrir o carrinho", [], []);
    expect(isAmbiguous(query, "click", "e1")).toBe(true);
    expect(isAmbiguous(query, "click", "e3")).toBe(false);
    expect(isAmbiguous(query, "click", "e4")).toBe(false);
  });

  it("o Jev escolhendo um dos ícones sem nome, mesmo com confiança, aciona a foto em vez de chutar", async () => {
    const h = visualHarness([ok("click", "e1", 0.8), ok("done")], seen([0.9, 0.1]), Array.from({ length: 6 }, (_, i) => ICONS.replace("Loja", `Loja ${i}`)));
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(h.calls).toEqual([]); // não clicou no ícone errado pelo texto
    expect(h.clicks).toEqual([[900, 60]]); // janela 1000×600
    expect(result.outcome).toBe("done");
  });

  it("sem a reserva visual, para e explica que o texto não distingue os ícones", async () => {
    const result = await runPilot("abrir o carrinho", [], undefined, harness([ok("click", "e1", 0.8)], [ICONS]).deps);
    expect(result.outcome).toBe("unsure");
    expect(result.note).toContain("não tem nome");
  });
});

describe("campo sensível preenchido", () => {
  it("senha, cartão ou token preenchidos bloqueiam a foto; vazios ou outros campos, não", () => {
    expect(sensitiveFilled(parseSnapshot(LOGIN))).toBe(true);
    expect(sensitiveFilled(parseSnapshot(CLEAN))).toBe(false);
    expect(sensitiveFilled(parseSnapshot('page: "x" http://a.test/\n- textbox "Card number" [ref=e1] value="4111"'))).toBe(true);
    expect(sensitiveFilled(parseSnapshot('page: "x" http://a.test/\n- textbox "Nome" [ref=e1] value="Ana"'))).toBe(false);
  });
});

// ── Listas, objetivo atingido e navegação ───────────────────────────

const SORT = [
  'page: "Resultados" http://shop.test/s?k=fone', "viewport: 1000×600 · scroll 0/600", "",
  '- combobox "Classificar por" [ref=e1] value="Em destaque" options=["Em destaque","Preço: do menor ao maior","Preço: do maior ao menor"]',
  '- link "Fone Bluetooth P47" [ref=e2] → /Fone-Bluetooth-P47/dp/B07C97XS47?ref=sr_1_1',
  '- button "Filtros" [ref=e3]',
].join("\n");

/** Uma página por passo, com um texto que muda: a impressão da página (o que diz se uma ação teve efeito) não olha o título. */
function sortPages(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${SORT}\n- text "página ${i}"`);
}

describe("listas com opções", () => {
  it("o snapshot da lista traz as opções, e cada uma vira um alvo, sem precisar de --fill", () => {
    const page = parseSnapshot(SORT);
    expect(page.elements[0].options).toEqual(["Em destaque", "Preço: do menor ao maior", "Preço: do maior ao menor"]);
    const query = buildStep(page, "ordenar por preço, do menor para o maior", [], []);
    expect(query.targets.select.map((o) => o.id)).toEqual(["e1_0", "e1_1", "e1_2"]);
    expect(query.targets.select[1].label).toBe('dropdown "Classificar por" → option "Preço: do menor ao maior"');
    expect(query.operations.map((o) => o.id)).toContain("select");
    // a lista com opções não aparece também como elemento solto: a escolha é por opção
    expect(query.targets.click.map((o) => o.id)).not.toContain("e1");
    expect(query.state).toContain("with options: Em destaque | Preço: do menor ao maior");
  });

  it("o piloto escolhe a opção que o Jev apontou (e1_1) na lista e1, sem valor de --fill", async () => {
    const h = harness([ok("select", "e1_1"), ok("done")], sortPages(6));
    const result = await runPilot("ordenar por preço, do menor para o maior", [], undefined, h.deps);
    expect(h.calls).toEqual(["select e1 Preço: do menor ao maior"]);
    expect(result.steps.join("\n")).toContain('escolheu "Preço: do menor ao maior" em dropdown "Classificar por"');
    expect(result.outcome).toBe("done");
  });

  it("uma lista sem opções legíveis continua pedindo --fill", () => {
    const bare = parseSnapshot('page: "x" http://a.test/\n- combobox "País" [ref=e1] value=""');
    expect(buildStep(bare, "escolher o país", [], []).operations.map((o) => o.id)).not.toContain("select");
    expect(buildStep(bare, "escolher o país", ["País"], []).operations.map((o) => o.id)).toContain("select");
  });
});

describe("objetivo atingido (pergunta direta)", () => {
  const pages = () => sortPages(8);

  it("depois de uma ação dele que mudou a página, concluir mesmo com a operação incerta", async () => {
    const h = harness([ok("select", "e1_1"), ok("click", "e3", 0.2, 0.93)], pages());
    const result = await runPilot("ordenar por preço", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(result.steps.join("\n")).toContain("objetivo atingido (pergunta direta p=0.93)");
    expect(h.calls).toEqual(["select e1 Preço: do menor ao maior"]); // o clique incerto NÃO aconteceu
  });

  it("no primeiro passo, ou só com campos preenchidos pelo nome, não vale (ainda não fez nada)", async () => {
    const first = await runPilot("ordenar", [], undefined, harness([ok("click", "e3", 0.2, 0.99)], pages()).deps);
    expect(first.outcome).toBe("unsure");
    const form = pagesOf(8).map((p) => p.replace('value="[x]"', 'value=""'));
    const onlyFields = await runPilot("entrar", ["email=a@b.c"], undefined, harness([ok("click", "e4", 0.2, 0.99)], form).deps);
    expect(onlyFields.outcome).toBe("unsure");
  });

  it("uma ação que não mudou a página não conclui", async () => {
    const same = Array.from({ length: 5 }, () => SORT);
    const h = harness([ok("scroll"), ok("click", "e3", 0.2, 0.99)], same);
    const result = await runPilot("ordenar", [], undefined, h.deps);
    expect(result.outcome).not.toBe("done");
  });
});

describe("relatório de quem parou depois de agir", () => {
  it("mostra a pergunta direta de objetivo atingido e avisa que a página já mudou", async () => {
    const h = harness([ok("click", "e3"), ok("click", "e3", 0.2, 0.6)], sortPages(8));
    const result = await runPilot("filtrar", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(result.note).toContain("fim p=0.60");
    expect(result.note).toContain("o objetivo pode já ter sido atingido");
  });

  it("o limite de objetivo atingido é 0,75", async () => {
    const at = await runPilot("filtrar", [], undefined, harness([ok("click", "e3"), ok("click", "e3", 0.2, 0.76)], sortPages(8)).deps);
    expect(at.outcome).toBe("done");
    const below = await runPilot("filtrar", [], undefined, harness([ok("click", "e3"), ok("click", "e3", 0.2, 0.7)], sortPages(8)).deps);
    expect(below.outcome).toBe("unsure");
  });
});

describe("clicar num link espera a página carregar", () => {
  it("um link com destino avisa que vai navegar; um botão, não", async () => {
    const h = harness([ok("click", "e2"), ok("click", "e3"), ok("done")], sortPages(8));
    await runPilot("abrir o produto", [], undefined, h.deps);
    expect(h.navs).toEqual([true, false]);
  });
});

// ── Velocidade e o mesmo toque duas vezes ────────────────────────────

const ICONS_PAGE = ['page: "Loja" http://shop.test/', "viewport: 1000×600 · scroll 0/600", "", "- clickable [ref=e1]", "- clickable [ref=e2]"].join("\n");

describe("nunca fecha uma compra por acaso", () => {
  it("reconhece os botões que fecham compra ou pagam, só quando o objetivo não pediu", () => {
    expect(blockedPurchase("button | Comprar agora", "adicionar ao carrinho")).toBe(true);
    expect(blockedPurchase("Place your order", "open the cart")).toBe(true);
    expect(blockedPurchase("input#buy-now-button", "abrir o carrinho")).toBe(true);
    expect(blockedPurchase("button | Adicionar ao carrinho", "adicionar ao carrinho")).toBe(false);
    expect(blockedPurchase("button | Comprar agora", "comprar agora o produto")).toBe(false);
    expect(blockedPurchase("Finalizar compra", "finalizar a compra do carrinho")).toBe(false);
  });

  it("o texto: o Jev escolhe 'Comprar agora' sem o objetivo pedir, e o piloto não clica", async () => {
    const page = ['page: "Produto" http://shop.test/p/1', "viewport: 1000×600 · scroll 0/600", "", '- button "Adicionar ao carrinho" [ref=e1]', '- button "Comprar agora" [ref=e2]'].join("\n");
    const h = harness([ok("click", "e2")], [page]);
    const result = await runPilot("adicionar ao carrinho", [], undefined, h.deps);
    expect(result.outcome).toBe("stuck");
    expect(h.calls).toEqual([]);
    expect(result.note).toContain("compra ou pagamento");
  });

  it("a foto: se o ponto aponta um botão de compra, não toca", async () => {
    const h = visualHarness([ok("click", "e1", 0.1)], seen([0.5, 0.5]));
    h.deps.peekAt = async () => "input#buy-now-button | Comprar agora";
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(h.clicks).toEqual([]);
    expect(result.steps.join("\n")).toContain("controle de compra ou pagamento");
  });
});

describe("texto da página que vai ao Jev", () => {
  it("as linhas do objetivo vêm primeiro, mesmo no fim de uma página cheia de menu", () => {
    const menu = Array.from({ length: 80 }, (_, i) => `Item de menu número ${i} com um texto comprido para encher`);
    const lines = [...menu, "Seu carrinho da Amazon está vazio"];
    const picked = pickText(lines, words("remover o produto do carrinho, deixando o carrinho vazio"));
    expect(picked).toContain("Seu carrinho da Amazon está vazio");
    expect(picked.join("\n").length).toBeLessThanOrEqual(3100);
  });

  it("sem linhas parecidas com o objetivo, fica o começo da página, na ordem", () => {
    const lines = ["primeira", "segunda", "terceira"];
    expect(pickText(lines, words("xyz abc"))).toEqual(lines);
  });
});

describe("foto duas vezes seguidas", () => {
  it("depois de um toque pela foto, não tira outra foto até uma ação normal", async () => {
    const h = visualHarness([ok("click", "e1", 0.1), ok("click", "e1", 0.1)], seen([0.1, 0.5]));
    let reads = 0;
    h.deps.snapshot = async () => `${ICONS_PAGE}\n- text "leitura ${reads++}"`;
    const result = await runPilot("filtrar", [], undefined, h.deps);
    expect(h.clicks).toHaveLength(1);
    expect(h.asked).toHaveLength(1);
    expect(result.steps.join("\n")).toContain("acabou de tocar");
  });
});

describe("velocidade do piloto", () => {
  it("só a operação wait espera de verdade (a rede ociosa); as ações esperam pouco", async () => {
    const h = harness([ok("click", "e3"), ok("wait"), ok("done")], sortPages(8));
    await runPilot("filtrar", [], undefined, h.deps);
    // um clique (rápido), um wait (a espera de verdade) e o fim
    expect(h.settles.filter(Boolean)).toHaveLength(1);
    expect(h.settles.filter((thorough) => !thorough).length).toBeGreaterThanOrEqual(1);
  });

  it("cada passo do relatório diz quanto levou", async () => {
    const h = harness([ok("click", "e3"), ok("done")], sortPages(8));
    const result = await runPilot("filtrar", [], undefined, h.deps);
    expect(result.steps[0]).toMatch(/passo \d+ ms\)/);
  });
});

describe("a foto não toca duas vezes no mesmo lugar", () => {
  it("se a segunda foto aponta onde a primeira já tocou, não repete (um filtro ligado vira desligado)", async () => {
    // foto → uma ação normal (rolar) → incerto de novo → a foto aponta o mesmo lugar
    const h = visualHarness([ok("click", "e1", 0.1), ok("scroll", null, 0.9), ok("click", "e1", 0.1)], seen([0.075, 0.5]));
    // cada leitura traz uma página diferente (o toque mudou algo), como numa página de verdade
    let reads = 0;
    h.deps.snapshot = async () => `${ICONS_PAGE}\n- text "leitura ${reads++}"`;
    const result = await runPilot("filtrar", [], undefined, h.deps);
    expect(h.clicks).toHaveLength(1);
    expect(result.steps.join("\n")).toContain("mesmo lugar de um toque anterior");
    expect(result.outcome).toBe("unsure");
  });
});

describe("buscas que exigem Enter", () => {
  const SEARCH = [
    'page: "Loja" http://localhost/',
    "viewport: 1280×800 · scroll 0/800",
    '- searchbox "Pesquisar" [ref=e1] value=""',
    '- button "" [ref=e2]',
    '- textbox "Nome" [ref=e3] value=""',
  ].join("\n");

  it("reconhece campos de busca pelo papel ou pelo nome", () => {
    const [search, , name] = parseSnapshot(SEARCH).elements;
    expect(isSearchField(search)).toBe(true);
    expect(isSearchField(name)).toBe(false);
    expect(isSearchField({ ref: "e9", role: "textbox", name: "Search Amazon", states: [], filled: false })).toBe(true);
    // o "q" solto é busca; a letra q dentro de outra palavra não é
    for (const name of ["Quantidade", "Quantity", "Equipe", "Sequência", "Cheque", "Required"]) {
      expect(isSearchField({ ref: "e9", role: "textbox", name, states: [], filled: false }), name).toBe(false);
    }
    expect(isSearchField({ ref: "e9", role: "textbox", name: "q", states: [], filled: false })).toBe(true);
  });

  it("não aperta Enter com um controle de compra à vista que o objetivo não pediu", () => {
    const page = parseSnapshot(['page: "Carrinho" http://localhost/cart', '- searchbox "Pesquisar" [ref=e1] value=""', '- button "Proceed to checkout" [ref=e2]'].join("\n"));
    expect(submitsOnType(page.elements[0], page, "buscar fone")).toBe(false);
    expect(submitsOnType(page.elements[0], page, "comprar o fone e finalizar")).toBe(true);
    expect(submitsOnType(page.elements[0], undefined, "buscar fone")).toBe(true);
  });

  it("digitar numa busca aperta Enter; num campo comum, não", async () => {
    const submits: Record<string, boolean> = {};
    const h = harness([ok("done")], [SEARCH]);
    h.deps.type = async (ref, _text, submit) => { submits[ref] = !!submit; };
    const result = await runPilot("buscar", ["Pesquisar=fone", "Nome=Ana"], undefined, h.deps);
    expect(submits).toEqual({ e1: true, e3: false });
    expect(result.steps.join("\n")).toContain("e apertou Enter");
  });
});

describe("tempo por fase", () => {
  it("o resultado soma o tempo de cada fase e o relatório traz a linha TEMPOS legível por máquina", async () => {
    const h = harness([ok("click", "e4"), ok("done")]);
    const slow = (fn: () => Promise<unknown>) => async () => { await new Promise((r) => setTimeout(r, 5)); return fn(); };
    h.deps.snapshot = slow(h.deps.snapshot) as PilotDeps["snapshot"];
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.timings?.consultas).toBe(2);
    expect(result.timings?.snapshot).toBeGreaterThan(0);
    expect(result.timings?.total).toBeGreaterThanOrEqual(result.timings!.snapshot);
    const line = formatResult("entrar", result).split("\n").find((l) => l.startsWith("TEMPOS: "));
    expect(JSON.parse(line!.slice("TEMPOS: ".length))).toMatchObject({ consultas: 2, fotos: 0 });
  });
});

describe("compra que o objetivo não pediu", () => {
  const PRODUTO = [
    'page: "Fone" http://localhost/p',
    "viewport: 1280×800 · scroll 0/800",
    '- button "Comprar agora" [ref=e1]',
    '- button "Adicionar ao carrinho" [ref=e2]',
  ].join("\n");

  it("o botão de compra nem é oferecido ao Jev: ele escolhe entre os outros", () => {
    const step = buildStep(parseSnapshot(PRODUTO), "adicionar o fone ao carrinho", [], []);
    expect(step.targets.click.map((o) => o.id)).toEqual(["e2"]);
    expect(step.state).not.toContain("Comprar agora");
  });

  it("se o objetivo pede a compra, o botão volta", () => {
    const step = buildStep(parseSnapshot(PRODUTO), "comprar o fone agora", [], []);
    expect(step.targets.click.map((o) => o.id)).toEqual(["e1", "e2"]);
  });
});
