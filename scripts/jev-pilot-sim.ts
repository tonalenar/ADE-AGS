/**
 * Mede o piloto do Jev de ponta a ponta SEM um navegador: o `runPilot` real, o Jev real (pelo `decision_pick_step`
 * de uma instância de debug com a porta de depuração do WebView2 aberta) e uma página simulada em memória, que só
 * muda quando o piloto age. Só dados fictícios saem para o Jev.
 *
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 (na instância de debug)
 *   bun scripts/jev-pilot-sim.ts [porta]
 */
import { formatResult, runPilot, type PilotDeps, type StepQuery, type StepReply } from "../src/features/browser/jevPilot";

const port = process.argv[2] ?? "9223";

interface Field { role: string; name: string; value?: string; checked?: boolean }

/** O formulário de pedido de pizza do httpbin, como o `snapshot` o descreveria. */
function pizzaPage() {
  const fields: Field[] = [
    { role: "textbox", name: "Customer name", value: "" },
    { role: "textbox", name: "Telephone", value: "" },
    { role: "textbox", name: "E-mail address", value: "" },
    { role: "radio", name: "Small" }, { role: "radio", name: "Medium" }, { role: "radio", name: "Large" },
    { role: "checkbox", name: "Bacon" }, { role: "checkbox", name: "Extra Cheese" }, { role: "checkbox", name: "Onion" }, { role: "checkbox", name: "Mushroom" },
    { role: "textbox", name: "Preferred delivery time", value: "" },
    { role: "textbox", name: "Delivery instructions", value: "" },
    { role: "button", name: "Submit order" },
  ];
  let submitted = false;
  const snapshot = () => {
    if (submitted) return ['page: "Order" http://httpbin.org/post', "", '- heading "Thanks"', '- text "Your order was submitted."', '- link "Back" [ref=e1]'].join("\n");
    return [
      'page: "Pizza order" http://httpbin.org/forms/post', "viewport: 1280×800 · scroll 0/900", "",
      ...fields.map((f, i) => `- ${f.role} "${f.name}" [ref=e${i + 1}]${f.checked ? " [checked]" : ""}${f.value !== undefined ? ` value="${f.value}"` : ""}`),
    ].join("\n");
  };
  const at = (ref: string) => fields[Number(ref.slice(1)) - 1];
  const actions: Pick<PilotDeps, "click" | "type" | "select" | "scroll" | "settle" | "snapshot"> = {
    snapshot: async () => snapshot(),
    click: async (ref) => {
      const f = at(ref);
      if (f.role === "radio") fields.filter((x) => x.role === "radio").forEach((x) => { x.checked = x === f; });
      else if (f.role === "checkbox") f.checked = !f.checked;
      else if (f.name === "Submit order") submitted = true;
    },
    type: async (ref, text) => { at(ref).value = text; },
    select: async () => undefined,
    scroll: async () => undefined,
    settle: async () => undefined,
  };
  return { actions, state: () => ({ fields, submitted }) };
}

/** Uma página de resultados de loja: uma lista "Classificar por" (select nativo), um botão de filtros e produtos. */
function shopPage() {
  const options = ["Em destaque", "Preço: do menor ao maior", "Preço: do maior ao menor", "Média de avaliações"];
  let sorted = 0;
  const snapshot = () => [
    'page: "Resultados: fone bluetooth" http://shop.test/s?k=fone', "viewport: 1280×800 · scroll 0/2000", "",
    '- searchbox "Pesquisar" [ref=e1] value="fone bluetooth"',
    '- button "Ir" [ref=e2]',
    '- button "Filtros" [ref=e3]',
    `- combobox "Classificar por" [ref=e4] value="${options[sorted]}" options=${JSON.stringify(options)}`,
    sorted === 1 ? '- text "Ordenado por: Preço: do menor ao maior"' : `- text "Ordenado por: ${options[sorted]}"`,
    '- link "Fone Bluetooth P47 R$ 7,21" [ref=e5] → /Fone-Bluetooth-P47/dp/B07C97XS47',
    '- link "Fone Gamer RGB R$ 49,90" [ref=e6] → /Fone-Gamer-RGB/dp/B08XYZ1234',
    '- link "Fone Esportivo R$ 31,00" [ref=e7] → /Fone-Esportivo/dp/B09ABC5678',
  ].join("\n");
  const actions: Pick<PilotDeps, "click" | "type" | "select" | "scroll" | "settle" | "snapshot"> = {
    snapshot: async () => snapshot(),
    click: async () => undefined,
    type: async () => undefined,
    select: async (_ref, value) => { sorted = Math.max(0, options.indexOf(value)); },
    scroll: async () => undefined,
    settle: async () => undefined,
  };
  return { actions, state: () => ({ sorted: options[sorted] }) };
}

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(pages.find((p) => p.type === "page")!.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (m) => { const j = JSON.parse(String(m.data)); if (j.id && pending.has(j.id)) { pending.get(j.id)!(j); pending.delete(j.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const pick = async (query: StepQuery): Promise<StepReply> => {
    const i = ++id;
    const expression = `window.__TAURI_INTERNALS__.invoke("decision_pick_step", ${JSON.stringify({ query })}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ status: "error", reason: String(e) }))`;
    const answer = await new Promise<any>((resolve) => { pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
    return JSON.parse(answer.result.result.value) as StepReply;
  };
  return { pick, close: () => ws.close() };
}

const runs: { name: string; goal: string; fills: string[]; expect: (s: ReturnType<ReturnType<typeof pizzaPage>["state"]>) => boolean }[] = [
  {
    name: "objetivo explícito",
    goal: "Fill the pizza order: choose size Medium and topping Bacon, then submit the order",
    fills: ["Customer name=Maria Teste", "Telephone=11999990000", "E-mail address=maria@teste.com"],
    expect: (s) => s.submitted && s.fields.find((f) => f.name === "Medium")?.checked === true && s.fields.find((f) => f.name === "Bacon")?.checked === true,
  },
  {
    name: "objetivo em português",
    goal: "preencher o pedido de pizza com tamanho Grande e cobertura Cogumelo (Mushroom) e enviar",
    fills: ["Customer name=Joao Teste", "Telephone=11888880000", "E-mail address=joao@teste.com"],
    expect: (s) => s.submitted && s.fields.find((f) => f.name === "Large")?.checked === true && s.fields.find((f) => f.name === "Mushroom")?.checked === true,
  },
  {
    name: "objetivo vago",
    goal: "preencher o pedido de pizza e enviar",
    fills: ["Customer name=Ana Teste", "Telephone=11777770000", "E-mail address=ana@teste.com"],
    expect: (s) => s.submitted,
  },
];

const jev = await connect();
// O cenário da loja: ordenar escolhendo uma OPÇÃO da lista, sem --fill, e concluir sozinho.
{
  const shop = shopPage();
  let calls = 0;
  let jevMs = 0;
  const deps: PilotDeps = { ...shop.actions, pick: async (query) => { calls++; const reply = await jev.pick(query); jevMs += reply.latencyMs ?? 0; return reply; } };
  const started = performance.now();
  const result = await runPilot("ordenar os resultados por preço, do menor para o maior", [], undefined, deps);
  console.log(`\n=== loja: ordenar por preço — ${result.outcome.toUpperCase()} — ordenação final: ${shop.state().sorted} — ${calls} consultas (${jevMs} ms), ${Math.round(performance.now() - started)} ms no total`);
  console.log(result.steps.join("\n"));
}
for (const run of runs) {
  const page = pizzaPage();
  let calls = 0;
  let jevMs = 0;
  const deps: PilotDeps = {
    ...page.actions,
    pick: async (query) => {
      calls++;
      const reply = await jev.pick(query);
      jevMs += reply.latencyMs ?? 0;
      return reply;
    },
  };
  const started = performance.now();
  const result = await runPilot(run.goal, run.fills, undefined, deps);
  const total = Math.round(performance.now() - started);
  console.log(`\n=== ${run.name} — ${result.outcome.toUpperCase()} — objetivo cumprido: ${run.expect(page.state())} — ${calls} consultas ao Jev (${jevMs} ms), ${total} ms no total`);
  console.log(result.steps.join("\n"));
  if (result.outcome !== "done") console.log(formatResult(run.goal, result).split("\n").slice(0, 3).join("\n"));
}
jev.close();
process.exit(0);
