/**
 * Mede, com o Jev real, a pergunta "o objetivo já foi atingido?" (`concluido`) numa página de loja cheia de menu, com e sem a
 * seleção do texto pelo objetivo. Só dados fictícios. Precisa de uma instância de debug com a porta de depuração aberta:
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223    bun scripts/jev-done-probe.ts [porta]
 */
import { buildStep, parseSnapshot, type StepQuery, type StepReply } from "../src/features/browser/jevPilot";

const port = process.argv[2] ?? "9223";

const menu = Array.from({ length: 80 }, (_, i) => `- text "Departamento ${i}: ofertas e lançamentos da semana para você"`);
const cartAfter = [
  'page: "Carrinho de compras da Amazon.com.br" https://shop.test/gp/cart/view.html', "viewport: 1920×1080 · scroll 0/1500", "",
  '- searchbox "Pesquisa" [ref=e1] value=""', '- link "Carrinho" [ref=e2] → /gp/cart/view.html', '- button "Ir para a busca" [ref=e3]',
  ...menu,
  '- text "Seu carrinho da Amazon está vazio"',
  '- text "0 itens no carrinho"',
].join("\n");

const history = [{ what: 'clicou button "Excluir Fone Orelhas GATO"', changed: true }];
const goal = "remover o produto do carrinho, deixando o carrinho vazio";

/** O texto como era: o fim da página (onde está a prova) não chegava. */
const oldText = (snapshot: string) => snapshot.split("\n").filter((l) => !/está vazio|0 itens no carrinho/.test(l)).join("\n");

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

const jev = await connect();
for (const [label, snapshot] of [["texto NOVO (pelo objetivo)", cartAfter], ["texto ANTIGO (primeiros 1.500 bytes)", oldText(cartAfter)]] as const) {
  for (let round = 1; round <= 3; round++) {
    const query = buildStep(parseSnapshot(snapshot), goal, [], history);
    const reply = await jev.pick(query);
    console.log(`${label} #${round}: fim p=${reply.goalDone?.toFixed(2)}  operação=${reply.operation} p=${reply.probability?.toFixed(2)}  "carrinho vazio" no texto: ${query.state.includes("está vazio")}`);
  }
}
jev.close();
process.exit(0);
