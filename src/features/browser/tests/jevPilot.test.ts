import { describe, expect, it } from "vitest";

import {
  MAX_PER_HEAD, MIN_PROBABILITY, words, bareUrl, buildStep, fingerprint, formatResult, parseFills, parseSnapshot, runPilot, valueFor,
  blockedPurchase, blockedControl, coverDismiss, zoomRegion, iconsIn, obviousAdvance, photoTapFinished, cartAdvance, isAmbiguous, isSearchField, submitsOnType, cartCount, emptyFieldsNote, exactLinkMissing, goalContradiction, missingFill, pickText, sensitiveFilled, type PageRegion, type PilotDeps, type StepQuery, type StepReply, type VisualReply,
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
    expect(page.text).toEqual(["Bem-vindo", "Entre na sua conta"]); // os títulos também são texto
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

  it("o Jev escolhendo digitar num campo sem valor não digita e diz qual --fill falta", async () => {
    // Dois valores e nenhum parecido com o campo: não adivinha qual vai onde.
    const h = harness([ok("type", "e1")]);
    const result = await runPilot("entrar", ["cpf=000", "cep=111"], undefined, h.deps);
    // não é mais um erro seco: o Jev lê a falha e, se insistir no mesmo campo, o piloto para
    expect(result.outcome).toBe("stuck");
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

describe("campos vazios sem --fill", () => {
  it("avisa quando a página termina com campos de texto vazios e nada foi passado para eles", () => {
    const page = parseSnapshot(LOGIN);
    expect(emptyFieldsNote(page, 0)).toContain('"E-mail"');
    expect(emptyFieldsNote(page, 0)).not.toContain("Senha"); // já preenchida
    expect(emptyFieldsNote(page, 2)).toBe("");
  });
  it("não conta a busca como campo esquecido", () => {
    const page = parseSnapshot(['page: "L" http://localhost/', '- searchbox "Pesquisar" [ref=e1] value=""'].join("\n"));
    expect(emptyFieldsNote(page, 0)).toBe("");
  });
});

describe("controles repetidos e rolagem", () => {
  const LISTA = [
    'page: "Cozinha" http://localhost/c',
    "viewport: 1280×800 · scroll 0/2400",
    '- heading "Chaleira" [level=3]',
    '- text "R$ 129,90"',
    '- button "Adicionar" [ref=e1]',
    '- heading "Cafeteira" [level=3]',
    '- text "R$ 219,90"',
    '- button "Adicionar" [ref=e2]',
    '- button "Ajuda" [ref=e3]',
  ].join("\n");

  it("botões com o mesmo nome mostram o que vem antes deles (o produto e o preço)", () => {
    const step = buildStep(parseSnapshot(LISTA), "adicionar a Cafeteira", [], []);
    const labels = step.targets.click.map((o) => o.label);
    expect(labels[0]).toContain("next to: Chaleira | R$ 129,90");
    expect(labels[1]).toContain("next to: Cafeteira | R$ 219,90");
    // quem não se repete não ganha o ruído
    expect(labels[2]).toBe('button "Ajuda"');
    expect(isAmbiguous(step, "click", "e2")).toBe(false);
  });

  it("os títulos contam como texto da página", () => {
    expect(parseSnapshot(LISTA).text).toEqual(["Chaleira", "R$ 129,90", "Cafeteira", "R$ 219,90"]);
  });

  it("rolar muda a página mesmo sem elemento novo (senão duas rolagens seguidas parecem um círculo)", () => {
    const top = parseSnapshot(LISTA);
    const down = parseSnapshot(LISTA.replace("scroll 0/2400", "scroll 600/2400"));
    expect(fingerprint(top)).not.toBe(fingerprint(down));
    expect(top.scrollY).toBe(0);
    expect(down.scrollY).toBe(600);
  });
});

describe("controle coberto por uma faixa ou modal", () => {
  it("não desiste: o Jev vê a falha no histórico e escolhe o que está na frente", async () => {
    const h = harness([ok("click", "e4"), ok("click", "e5"), ok("done")], pagesOf(10).map((p) => p.replace('value="[x]"', 'value=""')));
    h.deps.click = async (ref) => {
      h.calls.push(`click ${ref}`);
      if (ref === "e4") throw new Error('button "Entrar" está coberto por div "Aceitar cookies" (div#banner). Feche o que está na frente.');
    };
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.calls).toEqual(["click e4", "click e5"]);
    // o Jev, na consulta seguinte, lê que o toque falhou e por quê
    expect(h.asked[1].state).toContain("está coberto por div");
    expect(h.asked[1].state).toContain("the page did not change");
  });

  it("se o Jev insiste no mesmo controle coberto, para em vez de girar em círculos", async () => {
    const h = harness([ok("click", "e4")], pagesOf(10).map((p) => p.replace('value="[x]"', 'value=""')));
    h.deps.click = async () => { throw new Error("botão está coberto por div (div#modal)."); };
    const result = await runPilot("entrar", [], undefined, h.deps);
    expect(result.outcome).toBe("stuck");
  });
});

describe("o piloto tira o que cobre a página (conjunto de teste J2)", () => {
  const LOJA = (cart: string, banner: boolean) => [
    'page: "Tienda Ejemplo" http://localhost:8765/gen/loja.html?f=adicionar&s=2',
    "viewport: 1920×1120 · scroll 0/1120",
    "",
    `- text "${cart}"`,
    '- heading "Caneca Térmica" [level=3]',
    '- button "Comprar" [ref=e1]',
    '- heading "Moedor Manual" [level=3]',
    '- button "Comprar" [ref=e2]',
    ...(banner ? ['- text "Usamos cookies para mejorar tu experiencia."', '- button "Aceptar" [ref=e3]', '- button "Rechazar" [ref=e4]'] : []),
  ].join("\n");

  it("recusa antes de fechar e nunca aceita nem assina", () => {
    expect(coverDismiss(parseSnapshot(LOJA("Carrito: 0", true)))?.ref).toBe("e4");
    const modal = parseSnapshot(LOJA("Carrito: 0", false).concat("\n", '- button "Suscribirme" [ref=e5]', "\n", '- button "No, gracias" [ref=e6]'));
    expect(coverDismiss(modal)?.ref).toBe("e6");
    expect(coverDismiss(parseSnapshot(LOJA("Carrito: 0", false)))).toBeNull();
    // o que já foi tentado não volta
    expect(coverDismiss(parseSnapshot(LOJA("Carrito: 0", true)), new Set(["e4"]))).toBeNull();
  });

  it("o botão coberto faz o piloto tocar «Rechazar» e o Jev escolhe de novo, já sem a faixa", async () => {
    const pages = [LOJA("Carrito: 0", true), LOJA("Carrito: 0", false), LOJA("Carrito: 1 · Caneca Térmica", false)];
    let page = 0;
    const calls: string[] = [];
    const h = harness([ok("click", "e1"), ok("click", "e1"), ok("done", null, 0.95)], pages);
    h.deps.snapshot = async () => pages[page];
    h.deps.click = async (ref) => {
      calls.push(`click ${ref}`);
      if (page === 0 && ref !== "e4") throw new Error('button "Comprar" está coberto por div#overlay (#overlay).');
      page++;
    };
    const result = await runPilot("Adicione «Caneca Térmica» ao carrinho.", [], undefined, h.deps);
    expect(calls).toEqual(["click e1", "click e4", "click e1"]);
    expect(result.outcome).toBe("done");
    expect(result.steps.join("\n")).toContain("para tirar o que cobria a página");
  });
});

describe("achados da revisão", () => {
  it("o valor do --fill só fica gasto depois de digitado: campo coberto falha e o valor volta a valer", async () => {
    const pages = pagesOf(10);
    const h = harness([ok("click", "e5"), ok("done")], pages);
    let covered = true;
    h.deps.type = async (ref, text) => {
      if (covered) throw new Error(`text field "E-mail" está coberto por div "cookies" (div#banner). Feche.`);
      h.calls.push(`type ${ref} ${text}`);
    };
    h.deps.click = async (ref) => { h.calls.push(`click ${ref}`); covered = false; };
    const result = await runPilot("entrar", ["email=a@b.c"], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.calls).toContain("type e1 a@b.c");
  });

  it("o carrinho do Magento (/checkout/cart) não é um botão de compra", () => {
    const page = parseSnapshot(['page: "Loja" http://localhost/', "viewport: 1280×800 · scroll 0/800", '- link "Carrinho" [ref=e1] → /checkout/cart/'].join("\n"));
    expect(blockedControl(page.elements[0], "abrir o carrinho")).toBe(false);
    expect(blockedControl({ ref: "e2", role: "link", name: "Finalizar", states: [], filled: null, href: "/checkout/pay" }, "abrir o carrinho")).toBe(true);
  });

  it("ícones sem nome e iguais também mostram o que vem antes", () => {
    const page = parseSnapshot([
      'page: "Loja" http://localhost/', "viewport: 1280×800 · scroll 0/800",
      '- text "Perfil"', '- clickable [ref=e1]', '- text "Carrinho"', '- clickable [ref=e2]',
    ].join("\n"));
    const labels = buildStep(page, "abrir o carrinho", [], []).targets.click.map((o) => o.label);
    expect(labels[0]).toContain("next to: Perfil");
    expect(labels[1]).toContain("next to: Carrinho");
  });
});

describe("rótulo curto o bastante para o provedor", () => {
  it("o estado vem antes do contexto e o contexto não passa de 48 caracteres", () => {
    const page = parseSnapshot([
      'page: "L" http://localhost/', "viewport: 1280×800 · scroll 0/800",
      '- text "Um título de produto bem comprido que não cabe inteiro"', '- text "R$ 1.299,90"',
      '- checkbox "Selecionar" [ref=e1] [checked]',
      '- text "Outro título de produto igualmente comprido e longo"', '- checkbox "Selecionar" [ref=e2]',
    ].join("\n"));
    const label = buildStep(page, "marcar", [], []).targets.click[0].label;
    expect(label.indexOf("(")).toBeGreaterThan(-1);
    expect(label.indexOf("checked")).toBeLessThan(label.indexOf("next to"));
    expect(page.elements[0].near!.length).toBeLessThanOrEqual(48);
  });
});

describe("o contexto traz o nome do produto, mesmo quando ele é um link antes do texto", () => {
  it("link do produto, descrição longa, preço e botão igual: o `near` é o produto e o preço", () => {
    const page = parseSnapshot([
      'page: "Loja" http://localhost/', "viewport: 1280×800 · scroll 0/800",
      '- link "Sauce Labs Backpack" [ref=e1] → /item/4',
      '- text "carry.allTheThings() with the sleek, streamlined Sly Pack that melds uncompromising style"',
      '- text "$29.99"', '- button "Add to cart" [ref=e2]',
      '- link "Sauce Labs Bike Light" [ref=e3] → /item/0',
      '- text "A red light isn\'t the desired state in testing but it sure helps when riding your bike at night."',
      '- text "$9.99"', '- button "Add to cart" [ref=e4]',
    ].join("\n"));
    expect(page.elements[1].near).toBe("Sauce Labs Backpack | $29.99");
    expect(page.elements[3].near).toBe("Sauce Labs Bike Light | $9.99");
    const step = buildStep(page, "adicionar a Sauce Labs Backpack ao carrinho", [], []);
    expect(step.targets.click.map((o) => o.label).filter((l) => l.includes("Add to cart"))).toEqual([
      'button "Add to cart" [next to: Sauce Labs Backpack | $29.99]',
      'button "Add to cart" [next to: Sauce Labs Bike Light | $9.99]',
    ]);
  });
});

describe("valor que falta", () => {
  it("'não há valor' não encerra o act: o Jev lê a falha e escolhe o botão", async () => {
    const h = harness([ok("type", "e1"), ok("click", "e3"), ok("done")], pagesOf(10).map((p) => p.replace('value="[x]"', 'value=""')));
    const result = await runPilot("entrar", ["Outro=1", "Mais=2"], undefined, h.deps);
    expect(h.asked[1].state).toContain("não há valor para");
    expect(result.outcome).not.toBe("error");
  });
});

describe("avançar um fluxo com p um pouco abaixo do piso", () => {
  const ETAPA = (nome: string) => [
    'page: "Etapa 1" http://localhost/e1', "viewport: 1280×800 · scroll 0/800",
    `- textbox "Nome" [ref=e1] value="${nome}"`, '- button "Próximo" [ref=e2]', '- button "Cancelar" [ref=e3]',
  ].join("\n");

  it("com os campos preenchidos, o único «Próximo» com p=0,36 vale", () => {
    const page = parseSnapshot(ETAPA("[x]"));
    expect(obviousAdvance(page, "click", "e2", 0.36, "enviar o pedido")).toBe(true);
    expect(obviousAdvance(page, "click", "e2", 0.2, "enviar o pedido")).toBe(false); // muito baixo
    expect(obviousAdvance(page, "click", "e3", 0.36, "enviar o pedido")).toBe(false); // não é avançar
    expect(obviousAdvance(page, "type", "e1", 0.36, "enviar o pedido")).toBe(false);
  });

  it("com um campo vazio na página, não: ainda falta preencher", () => {
    expect(obviousAdvance(parseSnapshot(ETAPA("")), "click", "e2", 0.36, "enviar o pedido")).toBe(false);
  });

  it("o laço segue em vez de parar com «sem certeza»", async () => {
    const h = harness([ok("click", "e2", 0.36), ok("done")], pagesOf(10).map(() => ETAPA("[x]")));
    h.deps.snapshot = (() => { let n = 0; return async () => ETAPA("[x]").replace("Próximo", `Próximo${n++ > 0 ? " " : ""}`).replace('page: "Etapa 1"', `page: "Etapa ${n}"`); })();
    const result = await runPilot("enviar o pedido", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.calls).toEqual(["click e2"]);
  });
});

describe("digitar só se há campo vazio", () => {
  const FILLED = [
    'page: "Etapa 1" http://localhost/e1', "viewport: 1280×800 · scroll 0/800",
    '- textbox "Nome" [ref=e1] value="[x]"', '- button "Próximo" [ref=e2]',
  ].join("\n");
  it("com todos os campos preenchidos, 'type' não é oferecido (os valores que sobram são de outra etapa)", () => {
    const step = buildStep(parseSnapshot(FILLED), "preencher o pedido", ["CEP"], []);
    expect(step.operations.map((o) => o.id)).not.toContain("type");
    expect(step.operations.map((o) => o.id)).toContain("click");
  });
  it("com um campo vazio, 'type' é oferecido", () => {
    const step = buildStep(parseSnapshot(FILLED.replace('value="[x]"', 'value=""')), "preencher o pedido", ["CEP"], []);
    expect(step.operations.map((o) => o.id)).toContain("type");
  });
});

describe("conferir o carrinho antes de dar por feito", () => {
  const head = ['page: "Your Cart" https://shop.test/cart', "viewport: 1000×600 · scroll 0/0", ""];
  const cartLines = (items: number) => [
    ...head,
    ...Array.from({ length: items }, (_, i) => `- button "Remove" [ref=e${i + 1}]`),
    '- link "Continue Shopping" [ref=e9]',
  ].join("\n");
  const cart = (items: number) => parseSnapshot(cartLines(items));
  const emptyCart = [...head, '- text "Seu carrinho está vazio"'].join("\n");

  it("objetivo de contagem: a página mostra outro número", () => {
    expect(goalContradiction("adicionar ao carrinho e confirmar que há 1 item", cart(2))).toContain("mostra 2");
    expect(goalContradiction("adicionar ao carrinho e confirmar que há 1 item", cart(1))).toBeNull();
    expect(goalContradiction("confirm the cart has two items", cart(2))).toBeNull();
  });

  it("objetivo de vazio: sobrou item com botão de remover", () => {
    expect(goalContradiction("esvaziar o carrinho", cart(1))).toContain("ainda há 1");
    expect(goalContradiction("deixar o carrinho vazio", cart(1))).toContain("ainda há 1");
    expect(goalContradiction("deixar o carrinho vazio", parseSnapshot(emptyCart))).toBeNull();
  });

  it("sem carrinho no objetivo, não confere nada", () => {
    expect(goalContradiction("mostrar 20 itens por página", cart(3))).toBeNull();
  });

  it("o Jev diz 'feito' com um item sobrando: o piloto continua e só conclui quando a página confere", async () => {
    const h = harness([ok("click", "e1"), ok("done"), ok("click", "e1"), ok("done")], [cartLines(2), cartLines(1), emptyCart]);
    const result = await runPilot("deixar o carrinho vazio", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(result.steps.join("\n")).toContain("a página não confere");
  });

  it("depois de duas dúvidas sem a página mudar, devolve 'sem certeza' em vez de 'feito'", async () => {
    const h = harness([ok("done")], [cartLines(1)]);
    const result = await runPilot("deixar o carrinho vazio", [], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
    expect(result.note).toContain("não confere");
  });
});

describe("recusa digitar sem --fill", () => {
  const snap = ['page: "Wiki" https://w.test', "viewport: 1000×600", "", '- searchbox "Search" [ref=e1] value=""', '- button "Search" [ref=e2]'].join("\n");
  const searchPage = parseSnapshot(snap);

  it("objetivo de pesquisar, campo vazio e nenhum --fill: diz o que passar", () => {
    expect(missingFill("pesquise Portugal", 0, searchPage)).toContain('--fill "Search=');
    expect(missingFill("search for Portugal", 0, searchPage)).not.toBeNull();
  });

  it("com --fill, ou sem verbo de digitar, ou sem campo vazio, segue", () => {
    expect(missingFill("pesquise Portugal", 1, searchPage)).toBeNull();
    expect(missingFill("abrir o carrinho", 0, searchPage)).toBeNull();
    const filled = parseSnapshot(snap.replace('value=""', 'value="x"'));
    expect(missingFill("pesquise Portugal", 0, filled)).toBeNull();
  });

  it("o piloto nem toca na página nem consulta o Jev", async () => {
    const h = harness([ok("click", "e2")], [snap]);
    const result = await runPilot("pesquise Portugal", [], undefined, h.deps);
    expect(result.outcome).toBe("error");
    expect(h.calls).toEqual([]);
    expect(h.asked).toHaveLength(0);
  });
});

describe("falha no meio do caminho", () => {
  it("a leitura que falha depois de um passo não joga fora o que já foi feito", async () => {
    const h = harness([ok("click", "e4"), ok("click", "e4")]);
    let reads = 0;
    const original = h.deps.snapshot;
    h.deps.snapshot = async () => {
      reads += 1;
      if (reads >= 3) throw new Error("A página não respondeu em 12 s.");
      return original();
    };
    const result = await runPilot("entrar", ["email=a@b.c", "senha=123"], undefined, h.deps);
    expect(result.outcome).toBe("error");
    expect(result.steps.join("\n")).toContain("clicou");
    expect(result.note).toContain("não respondeu");
    expect(result.note).toContain("snapshot");
  });

  it("falha já na primeira leitura continua sendo um erro puro", async () => {
    const h = harness([ok("done")]);
    h.deps.snapshot = async () => { throw new Error("sem página"); };
    await expect(runPilot("x", [], undefined, h.deps)).rejects.toThrow("sem página");
  });
});

describe("remover do carrinho: a contagem tem de cair", () => {
  const head = ['page: "Carrinho" https://shop.test/cart', "viewport: 1000×600 · scroll 0/0", ""];
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `- button "Excluir" [ref=e${i + 1}]`);
  const cart = (items: number) => parseSnapshot([...head, ...rows(items)].join("\n"));
  const emptyPage = [...head, '- text "Seu carrinho está vazio"'].join("\n");

  it("conta os itens do carrinho da página", () => {
    expect(cartCount(cart(2))).toBe(2);
    expect(cartCount(parseSnapshot([...head, '- text "Subtotal (3 itens)"'].join("\n")))).toBe(3);
    expect(cartCount(parseSnapshot(emptyPage))).toBe(0);
    expect(cartCount(parseSnapshot([...head, '- link "Início" [ref=e1]'].join("\n")))).toBeNull();
  });

  it("removeu um: conferido; nada mudou: recusa o 'feito'", () => {
    expect(goalContradiction("remover o produto do carrinho", cart(1), 2)).toBeNull();
    expect(goalContradiction("remover o produto do carrinho", cart(1), 1)).toContain("nada foi removido");
    expect(goalContradiction("remove the item from the cart", cart(2), 2)).toContain("nada foi removido");
  });

  it("sem carrinho no começo (não sabe quantos eram), não confere", () => {
    expect(goalContradiction("remover o produto do carrinho", cart(1), null)).toBeNull();
    expect(goalContradiction("remover o produto do carrinho", cart(1), 0)).toBeNull();
  });

  it("o piloto: o Jev diz 'feito' sem a contagem cair, e só conclui depois que o item sai", async () => {
    const one = [...head, ...rows(1)].join("\n");
    const h = harness([ok("done"), ok("click", "e1"), ok("done")], [one, emptyPage]);
    const result = await runPilot("remover o produto do carrinho", [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(result.steps.join("\n")).toContain("a página não confere");
  });
});

describe("página de erro nunca é o objetivo cumprido", () => {
  it("«Desculpe! Algo deu errado» desmente o 'feito'", () => {
    const page = parseSnapshot(['page: "Amazon.com.br" https://amazon.test/cart', "", '- heading "Desculpe! Algo deu errado" [level=1]'].join("\n"));
    expect(goalContradiction("adicionar ao carrinho", page)).toContain("mostra um erro");
    expect(goalContradiction("mostrar a mensagem de erro", page)).toBeNull();
  });

  it("uma página normal não é confundida com erro", () => {
    const page = parseSnapshot(['page: "Carrinho" https://shop.test/cart', "", '- text "Seu carrinho"'].join("\n"));
    expect(goalContradiction("abrir o carrinho", page)).toBeNull();
  });
});

describe("busca enviada com Enter", () => {
  it("lida cedo demais a página é a mesma: o piloto espera e relê antes de perguntar ao Jev", async () => {
    const before = ['page: "Wiki" https://w.test', "viewport: 1000×600", "", '- searchbox "Search" [ref=e1] value=""', '- button "Search" [ref=e2]'].join("\n");
    const after = ['page: "Portugal" https://w.test/Portugal', "viewport: 1000×600", "", '- heading "Portugal" [level=1]', '- text "Capital: Lisbon"'].join("\n");
    const h = harness([ok("done")], [before]);
    let reads = 0;
    h.deps.snapshot = async () => (++reads <= 3 ? before : after);
    const thorough: boolean[] = [];
    h.deps.settle = async (t) => { thorough.push(!!t); };
    const result = await runPilot("pesquisar Portugal", ["Search=Portugal"], undefined, h.deps);
    expect(thorough.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(h.asked[0].state).toContain("Capital: Lisbon");
    expect(result.outcome).toBe("done");
  });
});

describe("busca enviada pelo piloto e sugestões (L04, N06)", () => {
  const home = ['page: "Loja" https://shop.test/', "viewport: 1000×600", "", '- searchbox "Buscar produtos" [ref=e1] value=""', '- button "Buscar" [ref=e2]'].join("\n");
  const results = ['page: "Resultados" https://shop.test/busca?q=tenis', "viewport: 1000×600", "", '- heading "Resultados para: tenis" [level=1]', '- link "Tênis" [ref=e1]'].join("\n");

  it("L04: a busca que o piloto enviou levou a outra página e o «acabou» com p=0,7 basta", async () => {
    const h = harness([{ ...ok("done", null, 0.7), goalDone: 0.7 }], [home, results]);
    const result = await runPilot("Pesquise por tênis na loja.", ["Buscar produtos=tenis"], undefined, h.deps);
    expect(result.outcome).toBe("done");
  });

  it("L04: se o Enter não mudou a página, o «acabou» sem ação continua sem valer", async () => {
    const h = harness([{ ...ok("done", null, 0.7), goalDone: 0.7 }], [home]);
    const result = await runPilot("Pesquise por tênis na loja.", ["Buscar produtos=tenis"], undefined, h.deps);
    expect(result.outcome).toBe("unsure");
  });

  it("N06: se o objetivo manda escolher uma sugestão, digitar não aperta Enter", async () => {
    const h = harness([ok("done")], [home]);
    const submits: boolean[] = [];
    h.deps.type = async (_ref, _text, submit) => { submits.push(!!submit); };
    await runPilot("Pesquise por fone e escolha a sugestão «fone bluetooth» na lista.", ["Buscar produtos=fone"], undefined, h.deps);
    expect(submits).toEqual([false]);
    const submits2: boolean[] = [];
    const h2 = harness([ok("done")], [home]);
    h2.deps.type = async (_ref, _text, submit) => { submits2.push(!!submit); };
    await runPilot("Pesquise por fone na loja.", ["Buscar produtos=fone"], undefined, h2.deps);
    expect(submits2).toEqual([true]);
  });
});

describe("link exato fora do recorte (P02)", () => {
  const cut = ['page: "Brasil" https://pt.wikipedia.org/wiki/Brasil', "viewport: 1000×600 · scroll 0/40000", "", '- link "Portugal" [ref=e1] → /wiki/Imp%C3%A9rio_Portugu%C3%AAs', '- link "Espanha" [ref=e2] → /wiki/Espanha'].join("\n");
  const whole = ['page: "Brasil" https://pt.wikipedia.org/wiki/Brasil', "viewport: 1000×600 · scroll 0/40000", "", '- link "Portugal" [ref=e1] → /wiki/Imp%C3%A9rio_Portugu%C3%AAs', '- link "Espanha" [ref=e2] → /wiki/Espanha', '- link "Portugal" [ref=e9] → /wiki/Portugal'].join("\n");
  const goal = "Abra o artigo clicando em um link «Portugal» do texto";

  it("só acusa quando há link com o nome e nenhum vai ao destino citado", () => {
    expect(exactLinkMissing(parseSnapshot(cut), goal)).toBe(true);
    expect(exactLinkMissing(parseSnapshot(whole), goal)).toBe(false);
    expect(exactLinkMissing(parseSnapshot(cut), "abrir o artigo sobre Portugal")).toBe(false);
    expect(exactLinkMissing(parseSnapshot(cut), "abrir «Dinamarca»")).toBe(false);
  });

  it("o piloto lê a página inteira, escolhe entre os links exatos e clica no certo", async () => {
    const h = harness([ok("click", "e9"), ok("done")], [cut, whole]);
    let wholeReads = 0;
    h.deps.snapshotAll = async () => { wholeReads += 1; return whole; };
    const result = await runPilot(goal, [], undefined, h.deps);
    expect(wholeReads).toBe(1);
    expect(h.asked[0].targets.click?.map((t) => t.id)).toContain("e9");
    expect(h.asked[0].targets.click?.map((t) => t.id)).not.toContain("e1");
    expect(result.steps.join("\n")).toContain("li a página inteira");
  });

  it("sem o link exato nem na página inteira, segue com o recorte e não insiste", async () => {
    const h = harness([ok("click", "e1")], [cut]);
    let reads = 0;
    h.deps.snapshotAll = async () => { reads += 1; return cut; };
    await runPilot(goal, [], undefined, h.deps);
    expect(reads).toBe(1);
  });
});

describe("SauceDemo com o item já no carrinho (P04)", () => {
  const GOAL = "Entre com o usuário e a senha de demonstração, adicione a Sauce Labs Backpack ao carrinho, vá ao checkout, preencha os dados fictícios e continue até o resumo (Overview). NÃO clique em Finish.";
  const product = (name: string, n: number, control: string) => [
    `  - button "View details for ${name}" [ref=e${n}] → /inventory.html#`, `  - button "View details for ${name}" [ref=e${n + 1}] → /inventory.html#`,
    '  - text "Uma descrição comprida do produto."', '  - text "$"', '  - text "29.99"', `  - button "${control}" [ref=e${n + 2}]`];
  const inventory = (backpack: string, bike: string, cart = "Cart, 1 items") => ['page: "Swag Labs" https://www.saucedemo.com/inventory.html', "viewport: 1920×1120 · scroll 0/1120", "",
    '- banner "header container"', '  - button "Open Menu" [ref=e1]', `  - button "${cart}" [ref=e2]`, '- main "inventory container"',
    ...product("Sauce Labs Backpack", 4, backpack), ...product("Sauce Labs Bike Light", 7, bike)].join("\n");
  const details = ['page: "Swag Labs" https://www.saucedemo.com/inventory-item.html?id=4', "viewport: 1920×1120 · scroll 0/1120", "",
    '- banner "header container"', '  - button "Cart, 1 items" [ref=e2]', '  - button "Back to products" [ref=e3]', '- main "inventory container"',
    '  - text "Sauce Labs Backpack"', '  - text "29.99"', '  - button "Remove" [ref=e4]'].join("\n");

  it("o botão com destino «View details for …» é o título dos que vêm depois, sem o «View details for»", () => {
    const page = parseSnapshot(inventory("Remove", "Add to cart"));
    expect(page.elements.find((e) => e.ref === "e6")?.near).toBe("Sauce Labs Backpack | 29.99");
    expect(page.elements.find((e) => e.ref === "e9")?.near).toBe("Sauce Labs Bike Light | 29.99");
    const query = buildStep(parseSnapshot(inventory("Add to cart", "Add to cart", "Cart")), GOAL, [], []);
    expect(query.targets.click.find((o) => o.id === "e6")?.label).toContain("[next to: Sauce Labs Backpack | 29.99]");
  });

  it("ir ao carrinho com p entre 0,30 e 0,40 vale quando o item do objetivo já está nele", () => {
    expect(cartAdvance(parseSnapshot(inventory("Remove", "Add to cart")), "click", "e2", 0.39, GOAL)).toBe(true);
    expect(cartAdvance(parseSnapshot(details), "click", "e2", 0.35, GOAL)).toBe(true);
  });

  it("não vale com outro item no carrinho, carrinho vazio, p baixa demais, outro alvo ou objetivo sem carrinho", () => {
    const other = parseSnapshot(inventory("Add to cart", "Remove"));
    expect(cartAdvance(other, "click", "e2", 0.39, GOAL)).toBe(false);
    expect(cartAdvance(parseSnapshot(inventory("Add to cart", "Add to cart", "Cart")), "click", "e2", 0.39, GOAL)).toBe(false);
    const inCart = parseSnapshot(inventory("Remove", "Add to cart"));
    expect(cartAdvance(inCart, "click", "e2", 0.25, GOAL)).toBe(false);
    expect(cartAdvance(inCart, "click", "e1", 0.39, GOAL)).toBe(false);
    expect(cartAdvance(inCart, "click", "e2", 0.39, "Abra o menu")).toBe(false);
    expect(cartAdvance(inCart, "click", "e2", 0.5, GOAL)).toBe(false); // acima do piso não precisa
  });

  it("o piloto clica no carrinho em vez de parar «sem certeza»", async () => {
    const h = harness([ok("click", "e2", 0.39)], [inventory("Remove", "Add to cart")]);
    const result = await runPilot(GOAL, [], 1, h.deps);
    expect(h.calls).toEqual(["click e2"]);
    expect(result.outcome).toBe("limit");
  });
});

describe("um toque pela foto que já cumpriu o objetivo (L12)", () => {
  const GOAL = "Clique no botão «Garantia estendida» que aparece no meio da foto do produto.";
  const shop = (status: string) => ['page: "ShopMart — foto do produto" http://localhost:8765/foto-garantia.html', "viewport: 1920×1120 · scroll 0/1120", "",
    "- main", `  - text "${status}"`, "  - clickable [ref=e1]", "  - clickable [ref=e2]", '  - text "Tênis de corrida Aero. R$ 399,90"', '  - button "Comprar" [ref=e3]'].join("\n");
  const before = parseSnapshot(shop("Nada aberto."));
  const sure = { foundProbability: 1, confidence: 0.91 };

  it("o objetivo de um clique só, a foto certa e o texto novo que fala do controle: acabou", () => {
    expect(photoTapFinished(GOAL, before, parseSnapshot(shop("GARANTIA ABERTA")), sure)).toBe("GARANTIA ABERTA");
    expect(photoTapFinished("Clique em «Continuar»", before, parseSnapshot(shop("Continuar: etapa 2")), sure)).toBe("Continuar: etapa 2");
  });

  it("o toque que caiu no vizinho, a página sem mudança ou com erro: não acabou", () => {
    expect(photoTapFinished(GOAL, before, parseSnapshot(shop("DETALHES ABERTOS")), sure)).toBeNull();
    expect(photoTapFinished(GOAL, before, before, sure)).toBeNull();
    expect(photoTapFinished(GOAL, before, parseSnapshot(shop("Erro ao abrir a garantia")), sure)).toBeNull();
    expect(photoTapFinished(GOAL, before, parseSnapshot(shop("Garantia: não foi possível carregar")), sure)).toBeNull();
  });

  it("um objetivo com mais etapas, que não é de clicar, ou uma foto sem certeza alta: não acabou", () => {
    const after = parseSnapshot(shop("GARANTIA ABERTA"));
    expect(photoTapFinished("Clique em «Garantia estendida» e depois adicione o produto ao carrinho", before, after, sure)).toBeNull();
    expect(photoTapFinished("Clique em «Garantia estendida»; escolha 2 anos", before, after, sure)).toBeNull();
    expect(photoTapFinished("Abra a garantia estendida", before, after, sure)).toBeNull();
    expect(photoTapFinished(GOAL, before, after, { foundProbability: 1, confidence: 0.7 })).toBeNull();
    expect(photoTapFinished(GOAL, before, after, { foundProbability: 0.8, confidence: 0.95 })).toBeNull();
  });

  function tapHarness(result: string) {
    const h = visualHarness([ok("click", "e1", 0.58, 0.01), ok("click", "e1", 0.5, 0.01)], seen([365 / 1920, 347 / 1120], true, 1, 0.91), [shop("Nada aberto.")]);
    let tapped = false;
    h.deps.snapshot = async () => shop(tapped ? result : "Nada aberto.");
    h.deps.clickAt = async (x, y) => { h.clicks.push([x, y]); tapped = true; };
    h.deps.peekAt = async () => "clickable";
    return h;
  }

  it("o piloto termina logo depois do toque, sem outra consulta ao Jev, e diz o que a página passou a mostrar", async () => {
    const h = tapHarness("GARANTIA ABERTA");
    const result = await runPilot(GOAL, [], undefined, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.clicks).toEqual([[365, 347]]);
    expect(h.asked).toHaveLength(1);
    expect(result.steps.join("\n")).toContain("objetivo atingido pelo toque da foto: a página passou a mostrar «GARANTIA ABERTA»");
    // Fase 6: o relatório diz por que a foto saiu, no que deu e quanto dela foi o Jev.
    expect(result.timings?.fotoUsos).toEqual(["passo 1: controle sem nome entre outros iguais (o texto apontava e1) → tocou e cumpriu o objetivo"]);
    expect(result.timings?.fotoJev).toBe(280);
    expect(formatResult(GOAL, result)).toMatch(/\nFOTO: 1 foto\(s\) · \d+ ms \(captura \d+ ms · Jev 280 ms\)(?: · \d+% do act)? · passo 1: controle sem nome/);
    // A parte «% do act» só sai com o act medido (> 0 ms); num relógio rápido ele dá 0 e ela some.
  });

  it("sem foto, o relatório não traz a linha FOTO; uma foto que não achou nada diz isso", async () => {
    const plain = await runPilot("entrar", [], undefined, harness([ok("click", "e4"), ok("done")]).deps);
    expect(formatResult("entrar", plain)).not.toContain("\nFOTO:");
    const none = await runPilot("abrir o carrinho", [], undefined, visualHarness([ok("click", "e4", 0.3)], seen(null, false, 0.97, 0.09)).deps);
    expect(none.timings?.fotoUsos).toEqual(["passo 1: sem certeza no texto (p=0.30, click e4) → A reserva visual também não achou um controle seguro na foto"]);
  });

  it("o toque no vizinho segue como antes: devolve a página sem dar por feito", async () => {
    const result = await runPilot(GOAL, [], undefined, tapHarness("DETALHES ABERTOS").deps);
    expect(result.outcome).toBe("unsure");
  });
});

describe("dois ícones sem nome: o segundo toque (L01)", () => {
  /** A foto aponta um ponto; o 1.º toque cai num ícone sem nome com um vizinho sem nome; a página nova não diz nada ao Jev. */
  function twoIcons(neighbors: number) {
    const pages = [ICONS_PAGE, `${ICONS_PAGE}\n- text "PROFILE OPENED"`, `${ICONS_PAGE}\n- text "CART OPENED"`];
    const h = visualHarness([ok("click", "e1", 0.3), ok("click", "e1", 0.3), ok("done")], seen([0.5, 0.5]), pages);
    const calls: string[] = [];
    let page = 0;
    h.deps.snapshot = async () => pages[Math.min(page, pages.length - 1)];
    h.deps.clickAt = async (x, y, second) => {
      calls.push(`${x},${y}${second ? "#2" : ""}`);
      page += 1;
      return second ? "{}" : JSON.stringify({ clicked: "clickable", unnamedNeighbors: neighbors });
    };
    h.deps.peekAt = async () => "clickable";
    return { h, calls };
  }

  it("com um vizinho sem nome ao lado, o piloto toca nele uma vez quando o primeiro não levou ao objetivo", async () => {
    const { h, calls } = twoIcons(1);
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(calls).toEqual(["500,300", "500,300#2"]);
    expect(result.steps.join("\n")).toContain("tocou no outro ícone sem nome");
  });

  it("sem vizinho sem nome, não tenta o segundo toque", async () => {
    const { h, calls } = twoIcons(0);
    await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(calls).toEqual(["500,300"]);
  });

  it("com o grupo de ícones, o segundo toque vem de uma foto AMPLIADA do grupo, não de adivinhar o vizinho", async () => {
    const { h, calls } = twoIcons(3);
    const group = { left: 400, top: 270, right: 640, bottom: 330 };
    h.deps.clickAt = async (x, y, second) => {
      calls.push(`${x},${y}${second ? "#2" : ""}`);
      return calls.length === 1 ? JSON.stringify({ clicked: "clickable", unnamedNeighbors: 3, unnamedGroup: group }) : "{}";
    };
    const regions: (PageRegion | undefined)[] = [];
    h.deps.visual = async (_goal, _recent, region) => {
      regions.push(region);
      return region ? seen([0.75, 0.5]) : seen([0.5, 0.5]);
    };
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    const zoom = zoomRegion(group, { width: 1000, height: 600 });
    expect(regions).toEqual([undefined, zoom]);
    const x = Math.round(zoom.left + 0.75 * (zoom.right - zoom.left));
    const y = Math.round(zoom.top + 0.5 * (zoom.bottom - zoom.top));
    expect(calls).toEqual(["500,300", `${x},${y}`]);
    expect(result.steps.join("\n")).toContain("foto ampliada da barra de ícones");
    expect(result.steps.join("\n")).not.toContain("tocou no outro ícone sem nome");
  });

  it("se a foto ampliada aponta o mesmo ícone já tocado, volta ao vizinho como antes", async () => {
    const { h, calls } = twoIcons(1);
    const group = { left: 470, top: 276, right: 530, bottom: 324 };
    h.deps.clickAt = async (x, y, second) => {
      calls.push(`${x},${y}${second ? "#2" : ""}`);
      return calls.length === 1 ? JSON.stringify({ clicked: "clickable", unnamedNeighbors: 1, unnamedGroup: group }) : "{}";
    };
    const zoom = zoomRegion(group, { width: 1000, height: 600 });
    h.deps.visual = async (_goal, _recent, region) => (region
      ? seen([(500 - zoom.left) / (zoom.right - zoom.left), (300 - zoom.top) / (zoom.bottom - zoom.top)])
      : seen([0.5, 0.5]));
    await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(calls).toEqual(["500,300", "500,300#2"]);
  });

  it("a foto aponta o vão entre ícones sem nome: o piloto não para, tira a foto ampliada do grupo e toca o que ela aponta", async () => {
    const { h, calls } = twoIcons(0);
    h.deps.clickAt = async (x, y, second) => {
      calls.push(`${x},${y}${second ? "#2" : ""}`);
      if (calls.length === 1) throw new Error(`Há mais de um controle perto do ponto (${x}, ${y}): não sei qual tocar. [grupo 400,270,640,330]`);
      return "{}";
    };
    const regions: (PageRegion | undefined)[] = [];
    h.deps.visual = async (_goal, _recent, region) => { regions.push(region); return region ? seen([0.25, 0.5]) : seen([0.5, 0.5]); };
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    const zoom = zoomRegion({ left: 400, top: 270, right: 640, bottom: 330 }, { width: 1000, height: 600 });
    expect(regions).toEqual([undefined, zoom]);
    expect(calls).toEqual(["500,300", `${Math.round(zoom.left + 0.25 * (zoom.right - zoom.left))},${Math.round(zoom.top + 0.5 * (zoom.bottom - zoom.top))}`]);
    expect(result.steps.join("\n")).toContain("foto ampliada da barra de ícones");
    expect(result.steps.join("\n")).not.toContain("[grupo");
  });

  it("o vão ambíguo sem grupo (controles com nome) para como antes, sem a etiqueta interna", async () => {
    const { h, calls } = twoIcons(0);
    h.deps.clickAt = async (x, y) => { calls.push(`${x},${y}`); throw new Error(`Há mais de um controle perto do ponto (${x}, ${y}): não sei qual tocar.`); };
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(calls).toEqual(["500,300"]);
    expect(result.steps.join("\n")).toContain("não sei qual tocar");
  });

  describe("os ícones numerados na foto ampliada", () => {
    const group = { left: 400, top: 270, right: 640, bottom: 330 };
    const icons = [[400, 276, 448, 324], [460, 276, 508, 324], [520, 276, 568, 324], [580, 276, 628, 324]];
    const boxes = icons.map(([left, top, right, bottom]) => ({ left, top, right, bottom }));
    const marked = (mark: number | null, markProbability: number | null): VisualReply => ({ ...seen([0.1, 0.5]), mark, markProbability });

    it("o Jev diz o número e o piloto toca o centro daquele ícone (não a caixa)", async () => {
      const { h, calls } = twoIcons(3);
      h.deps.clickAt = async (x, y, second) => {
        calls.push(`${x},${y}${second ? "#2" : ""}`);
        return calls.length === 1 ? JSON.stringify({ clicked: "clickable", unnamedNeighbors: 3, unnamedGroup: group, unnamedIcons: icons }) : "{}";
      };
      const asked: (PageRegion[] | undefined)[] = [];
      h.deps.visual = async (_goal, _recent, region, marks) => { asked.push(marks); return region ? marked(3, 0.97) : seen([0.5, 0.5]); };
      const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
      expect(asked).toEqual([undefined, boxes]);
      expect(calls).toEqual(["500,300", "544,300"]);
      expect(result.steps.join("\n")).toContain("selo 3 de 4");
    });

    it("no vão ambíguo, os ícones vêm na etiqueta do erro e o número decide", async () => {
      const { h, calls } = twoIcons(0);
      h.deps.clickAt = async (x, y) => {
        calls.push(`${x},${y}`);
        if (calls.length === 1) throw new Error(`Há mais de um controle perto do ponto (${x}, ${y}): não sei qual tocar. [grupo 400,270,640,330] [icones ${icons.map((b) => b.join(",")).join(";")}]`);
        return "{}";
      };
      h.deps.visual = async (_goal, _recent, region) => (region ? marked(1, 0.9) : seen([0.5, 0.5]));
      const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
      expect(calls).toEqual(["500,300", "424,300"]);
      expect(result.steps.join("\n")).not.toMatch(/\[(grupo|icones)/);
    });

    it("sem certeza no número (ou número fora dos selos), vale a caixa, como antes", async () => {
      const { h, calls } = twoIcons(3);
      h.deps.clickAt = async (x, y, second) => {
        calls.push(`${x},${y}${second ? "#2" : ""}`);
        return calls.length === 1 ? JSON.stringify({ clicked: "clickable", unnamedNeighbors: 3, unnamedGroup: group, unnamedIcons: icons }) : "{}";
      };
      h.deps.visual = async (_goal, _recent, region) => (region ? marked(2, 0.4) : seen([0.5, 0.5]));
      await runPilot("abrir o carrinho", [], undefined, h.deps);
      const zoom = zoomRegion(group, { width: 1000, height: 600 }, 40);
      expect(calls[1]).toBe(`${Math.round(zoom.left + 0.1 * (zoom.right - zoom.left))},${Math.round(zoom.top + 0.5 * (zoom.bottom - zoom.top))}`);
    });

    it("lê as caixas de unnamedIcons e ignora o que não for 4 números", () => {
      expect(iconsIn("[[1,2,3,4],[5,6,7,8]]")).toEqual([{ left: 1, top: 2, right: 3, bottom: 4 }, { left: 5, top: 6, right: 7, bottom: 8 }]);
      expect(iconsIn("[[1,2,3],[\"a\",1,2,3]]")).toBeUndefined();
      expect(iconsIn("não é json")).toBeUndefined();
      expect(iconsIn(undefined)).toBeUndefined();
    });
  });

  it("o toque pela foto que já fez a página conferir os --expect termina ali: não toca o vizinho (teste J2 v5, o sino)", async () => {
    const { h, calls } = twoIcons(3);
    let page = 0;
    const pages = [ICONS_PAGE, `${ICONS_PAGE}\n- text "NOTIFICAÇÕES ABERTAS"`];
    h.deps.snapshot = async () => pages[Math.min(page, pages.length - 1)];
    h.deps.clickAt = async (x, y, second) => {
      calls.push(`${x},${y}${second ? "#2" : ""}`);
      page += 1;
      return JSON.stringify({ clicked: "clickable", unnamedNeighbors: 3 });
    };
    h.deps.expectsMet = async (p) => (p ?? parseSnapshot(pages[Math.min(page, pages.length - 1)])).text.some((t) => t.includes("NOTIFICAÇÕES ABERTAS"));
    const result = await runPilot("Abra as notificações: é um dos ícones no topo da página.", [], undefined, h.deps);
    expect(calls).toEqual(["500,300"]);
    expect(result.outcome).toBe("done");
    expect(result.steps.join("\n")).toContain("os --expect passaram a conferir");
  });

  it("o recorte: o grupo com folga, largo o bastante, no máximo 3:1 e dentro da janela", () => {
    const bar = zoomRegion({ left: 1700, top: 26, right: 1880, bottom: 74 }, { width: 1920, height: 1120 });
    expect(bar.right).toBeLessThanOrEqual(1920);
    expect(bar.right - bar.left).toBeGreaterThanOrEqual(200);
    expect((bar.right - bar.left) / (bar.bottom - bar.top)).toBeLessThanOrEqual(3.01);
    const tiny = zoomRegion({ left: 0, top: 0, right: 40, bottom: 40 }, { width: 1000, height: 600 });
    expect(tiny.left).toBe(0);
    expect(tiny.right - tiny.left).toBeGreaterThanOrEqual(200);
    expect(tiny.top).toBe(0);
  });

  it("o vizinho que é compra ou pagamento não pedido não é tocado", async () => {
    const { h, calls } = twoIcons(1);
    h.deps.peekAt = async (_x, _y, second) => (second ? "button | Comprar agora" : "clickable");
    const result = await runPilot("abrir o carrinho", [], undefined, h.deps);
    expect(calls).toEqual(["500,300"]);
    expect(result.steps.join("\n")).toContain("compra ou pagamento");
  });
});
