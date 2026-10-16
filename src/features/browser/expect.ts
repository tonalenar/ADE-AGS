/**
 * `--expect`: o agente diz o que PROVA o sucesso e o piloto confere por código, sem o Jev (plano v2, Fase 5, achados V1 e V2).
 *
 *   --expect text:"Seu carrinho está vazio"   o texto está na página
 *   --expect url:/cart                         o endereço contém isto
 *   --expect count:1                           o carrinho da página tem 1 item (o «N itens» ou os botões de remover)
 *   --expect count:2@Caneca                    há 2 itens «Caneca» (ver countOf: um item com link + «Remover» conta uma vez)
 *   --expect absent:"Algo deu errado"          o texto NÃO está na página
 *
 * O relatório do `act` diz então **FEITO (verificado)**, **FEITO (não verificado)** (sem `--expect` e sem nada suspeito) ou
 * **NÃO CONFERE** (o piloto disse que acabou, mas a página desmente). Sem `--expect`, os verificadores genéricos (5.2)
 * procuram página de erro, mensagem de validação de formulário e «nenhum resultado». Tudo aqui é puro.
 */
import { cartCount, parseSnapshot, type ParsedPage, type PilotResult } from "./jevPilot";

export type ExpectKind = "text" | "absent" | "url" | "count";

export interface Expectation {
  kind: ExpectKind;
  /** O que foi pedido, como o agente escreveu (para o relatório). */
  raw: string;
  /** `text`/`absent`/`url`: o texto procurado. `count`: o texto contado (`@...`), ou vazio para o carrinho. */
  value: string;
  /** `text`/`absent`: o valor veio entre barras (`/regex/`). */
  pattern?: RegExp;
  /** `count`: quantas vezes. */
  n?: number;
}

export interface ExpectResult { raw: string; ok: boolean; detail: string }

export type Verdict = "verified" | "unverified" | "mismatch";

export interface Verification {
  verdict: Verdict;
  /** As linhas que vão para o relatório, já em PT-BR. */
  lines: string[];
}

const KINDS: ExpectKind[] = ["text", "absent", "url", "count"];

/** Tira acento, caixa e espaços repetidos: «Seu  Carrinho» confere com «seu carrinho». */
export function norm(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function unquote(value: string): string {
  const v = value.trim();
  const q = v[0];
  return v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1) : v;
}

/** Lê os `--expect`. Erros de sintaxe voltam em `errors` (o piloto não age sem entender o que deve provar). */
export function parseExpectations(rawList: string[]): { expects: Expectation[]; errors: string[] } {
  const expects: Expectation[] = [];
  const errors: string[] = [];
  for (const raw of rawList) {
    const at = raw.indexOf(":");
    const kind = (at > 0 ? raw.slice(0, at).trim().toLowerCase() : "") as ExpectKind;
    if (!KINDS.includes(kind)) {
      errors.push(`--expect «${raw}»: use text:, url:, count: ou absent: (ex.: --expect text:"Seu carrinho está vazio").`);
      continue;
    }
    const body = unquote(raw.slice(at + 1));
    if (kind === "count") {
      const m = /^(\d+)(?:@(.+))?$/.exec(body.trim());
      if (!m) { errors.push(`--expect «${raw}»: count: pede um número (count:1) ou número@texto (count:2@Caneca).`); continue; }
      expects.push({ kind, raw, n: Number(m[1]), value: unquote(m[2] ?? "") });
      continue;
    }
    if (!body) { errors.push(`--expect «${raw}»: falta o valor depois de ${kind}:.`); continue; }
    if (kind === "url") { expects.push({ kind, raw, value: body }); continue; }
    const rx = /^\/(.+)\/([a-z]*)$/.exec(body);
    if (rx) {
      try { expects.push({ kind, raw, value: body, pattern: new RegExp(rx[1], rx[2].includes("i") ? rx[2] : `${rx[2]}i`) }); continue; }
      catch { errors.push(`--expect «${raw}»: expressão regular inválida.`); continue; }
    }
    expects.push({ kind, raw, value: body });
  }
  return { expects, errors };
}

/** Todo o texto que a página mostra: título, linhas de texto, nomes e valores dos controles. */
export function pageTexts(page: ParsedPage): string[] {
  return [page.title, ...page.text, ...page.elements.map((el) => el.name)].filter(Boolean);
}

/**
 * Quantos ITENS mencionam o texto. Um item de carrinho aparece várias vezes na página (o título, o link da foto, o link do
 * nome, o botão «Remover Caneca Azul»): somar tudo dava 2–3 para um item só e um count:1@Caneca correto virava NÃO CONFERE.
 * Conta-se por categoria e fica o maior: linhas de texto; links (um por par nome+destino, para a foto e o nome não contarem
 * em dobro); e os demais controles (botões). Duas linhas do carrinho dão 2 em qualquer categoria.
 */
function countOf(page: ParsedPage, needle: string): number {
  const n = norm(needle);
  const has = (t: string) => norm(t).includes(n);
  const lines = page.text.filter(has).length;
  const links = new Set(page.elements.filter((el) => el.role === "link" && has(el.name)).map((el) => `${norm(el.name)}|${el.href ?? ""}`)).size;
  const controls = page.elements.filter((el) => el.role !== "link" && has(el.name)).length;
  return Math.max(lines, links, controls);
}

function hasText(texts: string[], e: Expectation): boolean {
  if (e.pattern) return texts.some((t) => e.pattern!.test(t));
  const needle = norm(e.value);
  return texts.some((t) => norm(t).includes(needle)) || norm(texts.join(" ")).includes(needle);
}

/** Confere uma expectativa contra a página. */
export function checkExpectation(e: Expectation, page: ParsedPage): ExpectResult {
  const texts = pageTexts(page);
  switch (e.kind) {
    case "text": {
      const ok = hasText(texts, e);
      return { raw: e.raw, ok, detail: ok ? `texto «${e.value}» presente` : `texto «${e.value}» não está na página` };
    }
    case "absent": {
      const found = hasText(texts, e);
      return { raw: e.raw, ok: !found, detail: found ? `«${e.value}» ainda aparece na página` : `«${e.value}» ausente` };
    }
    case "url": {
      const ok = page.url.toLowerCase().includes(e.value.toLowerCase());
      return { raw: e.raw, ok, detail: ok ? `endereço contém ${e.value}` : `endereço é ${page.url || "(desconhecido)"}, sem ${e.value}` };
    }
    case "count": {
      if (e.value) {
        const seen = countOf(page, e.value);
        return { raw: e.raw, ok: seen === e.n, detail: `${seen} item(ns) com «${e.value}», esperado ${e.n}` };
      }
      const seen = cartCount(page);
      if (seen === null) return { raw: e.raw, ok: false, detail: "a página não parece mostrar um carrinho com contagem" };
      return { raw: e.raw, ok: seen === e.n, detail: `carrinho com ${seen} item(ns), esperado ${e.n}` };
    }
  }
}

// Frases de ERRO, não de instrução: «Preencha os dados abaixo», «Informe um CEP» e «Please select a size» são o texto normal de um
// formulário, e «10 resultados» / «503 resultados» / «502 produtos» são contagens de uma busca que deu certo.
const VALIDATION = /campo (é )?obrigat[óo]rio|este campo [ée] obrigat[óo]rio|this field is required|\b(e-?mail|password|senha|name|field)\b.{0,20}\bis required\b|preencha (este|esse) campo|please fill (out )?this field|please (enter|select|choose) a valid|e-?mail inv[áa]lido|invalid e-?mail|enter a valid|informe um (e-?mail|cpf|cep|telefone|n[úu]mero|valor) v[áa]lido|digite um (e-?mail|n[úu]mero|valor) v[áa]lido/i;
const NO_RESULTS = /nenhum resultado|sem resultados|n[ãa]o encontramos (nenhum|resultado|produto|nada|itens)|no results? (found|for)|did not match any|(^|[^\d.,])0 resultados/i;
// Um código de erro HTTP sozinho («404») ou seguido do seu nome — nunca «503 resultados».
const ERROR_CODE = "(?:http |error |erro )?(?:404|500|502|503|504)";
const ERROR_PAGE = new RegExp(
  "algo deu errado|something went wrong|sorry! something|desculpe[,!]|p[áa]gina n[ãa]o encontrada|page not found|access denied|acesso negado"
  + "|^" + ERROR_CODE + "\\s*$"
  + "|^" + ERROR_CODE + "\\b\\s*[-–:.|]?\\s*(?:not found|bad gateway|service unavailable|gateway time-?out|internal server error|n[ãa]o encontrad|p[áa]gina|erro)",
  "i",
);

/**
 * Verificadores genéricos (5.2), ligados por padrão: o que uma página de «sucesso» não costuma mostrar. Só olha as linhas de
 * TEXTO do topo (não os nomes de controles: um rótulo «Obrigatório» não é um erro) e se cala quando o objetivo fala nisso.
 * Devolve o que achou de errado, ou `null`.
 */
export function genericProblem(goal: string, page: ParsedPage): string | null {
  const top = [page.title, ...page.text.slice(0, 30)];
  const mentions = (rx: RegExp) => rx.test(goal);
  if (!mentions(/\b(erro|error|falha|inv[áa]lid\w*|obrigat\w*|required)\b/i)) {
    const err = top.find((l) => ERROR_PAGE.test(l));
    if (err) return `a página mostra um erro («${err.slice(0, 80)}»).`;
    const val = page.text.slice(0, 60).find((l) => VALIDATION.test(l));
    if (val) return `o formulário mostra uma mensagem de validação («${val.slice(0, 80)}»): provavelmente não foi enviado.`;
    // Um campo que a própria página marcou como inválido (aria-invalid) também desmente um envio.
    const invalid = page.elements.filter((el) => el.states.includes("invalid"));
    if (invalid.length > 0) {
      return `${invalid.length} campo(s) marcado(s) como inválido(s) pela página («${invalid.slice(0, 2).map((el) => el.name).join("», «")}»): provavelmente o formulário não foi enviado.`;
    }
  }
  if (!mentions(/\b(nenhum|sem|zero|no|vazi[oa]|empty)\b/i)) {
    const none = top.find((l) => NO_RESULTS.test(l));
    if (none) return `a página diz que não há resultados («${none.slice(0, 80)}»).`;
  }
  return null;
}

/** O objetivo mexe em algo que vale conferir por código (carrinho, envio de formulário, filtro): sugere `--expect`. */
const WORTH_EXPECT = /carrinho|\bcart\b|sacola|basket|enviar|envio|submit|formul[áa]rio|cadastr|filtr\w*|aplicar|comprar|remov\w*|adicion\w*|add\b/i;

/**
 * O veredito do `act` (Fase 5.1/5.2). `outcome` é o que o piloto disse; `expects` os `--expect` do agente; `page` a página como
 * ficou (um snapshot COMPLETO). Pura.
 *   - com `--expect`: tudo confere ⇒ verificado; algo falha ⇒ NÃO CONFERE (mesmo que o piloto tenha dito FEITO);
 *   - sem `--expect`: um problema genérico ⇒ NÃO CONFERE; senão FEITO (não verificado).
 * Se o piloto NÃO disse FEITO mas tudo confere, o veredito é `verified` com a ressalva (o objetivo pode estar cumprido).
 */
export function verify(goal: string, outcome: PilotResult["outcome"], expects: Expectation[], page: ParsedPage): Verification {
  if (expects.length > 0) {
    const results = expects.map((e) => checkExpectation(e, page));
    const failed = results.filter((r) => !r.ok);
    const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.raw}: ${r.detail}`);
    if (failed.length > 0) return { verdict: "mismatch", lines };
    return { verdict: "verified", lines };
  }
  const problem = outcome === "done" ? genericProblem(goal, page) : null;
  if (problem) return { verdict: "mismatch", lines: [`✗ ${problem}`] };
  const lines = outcome === "done" && WORTH_EXPECT.test(goal)
    ? ["Dica: diga o que prova o sucesso com --expect (text:\"…\", url:/…, count:N ou absent:\"…\") e eu confiro por código, sem o Jev."]
    : [];
  return { verdict: "unverified", lines };
}

/**
 * Reescreve o relatório do `act` (ver `formatResult`) com o veredito: a 1.ª linha vira `FEITO (verificado)`, `FEITO (não
 * verificado)` ou `NÃO CONFERE`, e as linhas da conferência entram logo abaixo. Só mexe num relatório que o piloto deu por
 * FEITO ou, com `--expect`, em qualquer um (um PAROU com tudo conferindo ganha a nota). Pura.
 */
export function applyVerification(report: string, outcome: PilotResult["outcome"], v: Verification, hadExpects: boolean): string {
  const [head, ...rest] = report.split("\n");
  const m = /^(act ".*"): /.exec(head);
  if (!m) return report;
  const prefix = m[1];
  const block = (title: string) => [`${prefix}: ${title}`, ...(v.lines.length > 0 ? [`CONFERÊNCIA:`, ...v.lines.map((l) => `  ${l}`)] : [])];
  if (outcome === "done") {
    if (v.verdict === "verified") return [...block("FEITO (verificado)"), ...rest].join("\n");
    if (v.verdict === "mismatch") {
      return [...block("NÃO CONFERE"), "O piloto deu o objetivo por cumprido, mas a página não confere com o esperado: NÃO dê por feito. Veja a página abaixo e continue.", ...rest.slice(1)].join("\n");
    }
    return [...block("FEITO (não verificado)"), ...rest].join("\n");
  }
  if (hadExpects && v.verdict === "verified") {
    return [head, `CONFERÊNCIA: o piloto não deu por feito, mas tudo o que você esperava confere na página:`, ...v.lines.map((l) => `  ${l}`), ...rest].join("\n");
  }
  if (hadExpects && v.verdict === "mismatch") {
    return [head, `CONFERÊNCIA:`, ...v.lines.map((l) => `  ${l}`), ...rest].join("\n");
  }
  return report;
}

/** Atalho para a ponte: lê os `--expect`, confere contra o snapshot completo e devolve o relatório reescrito. */
export function verifyReport(report: string, goal: string, outcome: PilotResult["outcome"], rawExpects: string[], fullSnapshot: string): string {
  const { expects, errors } = parseExpectations(rawExpects);
  const page = parseSnapshot(fullSnapshot);
  const v = verify(goal, outcome, expects, page);
  const bad = errors.length > 0 ? `\n${errors.join("\n")}` : "";
  return applyVerification(report, outcome, v, expects.length > 0) + bad;
}
