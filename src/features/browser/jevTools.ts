/**
 * Ferramentas do Jev: `ags portal act … --save <nome>` grava o caminho que o Jev achou; `ags portal run <portal> <nome>`
 * refaz esse caminho SEM o Jev (sem modelo, sem custo, em segundos) e devolve o que a página mostra no fim.
 *
 * A ideia vem do Pomerado (MIT, github.com/Pomerado/pomerado): resolver uma vez com um modelo e publicar o resultado como
 * algo determinístico. Este protótipo é a versão mínima: só LEITURA (nada que salve, envie, compre ou apague), e o caminho
 * gravado é a lista de toques em elementos identificados pelo papel e pelo nome (nunca pelo `ref`, que muda a cada leitura).
 *
 * Tudo aqui é puro: a página e as ações entram por `PilotDeps`/`ToolRunDeps`, então gravar e reproduzir são testáveis sem
 * navegador.
 */

import { parseFills, parseSnapshot, type PageElement, type ParsedPage, type PilotDeps } from "./jevPilot";

export const TOOL_VERSION = 1;
/** Mesmo formato do Pomerado: começa com letra minúscula; só minúsculas, dígitos e `_`. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
export const DEFAULT_TEXT_LINES = 60;
export const MAX_ROWS = 200;

/** Como achar o elemento de novo numa leitura nova da página. */
export interface ElementMatch {
  role: string;
  name: string;
  /** O que vinha logo antes dele (distingue dois «Ver detalhes»). */
  near?: string;
  /** Para onde o link ia, sem consulta. */
  href?: string;
}

/** O valor digitado/escolhido: uma entrada da ferramenta (`--input campo=valor`) ou um texto fixo. */
export type ToolValue = { param: string } | { literal: string };

export type ToolStep =
  | { op: "click"; match: ElementMatch; optional?: boolean }
  | { op: "type"; match: ElementMatch; value: ToolValue; submit: boolean }
  | { op: "select"; match: ElementMatch; value: ToolValue }
  | { op: "scroll" };

/** O que a ferramenta devolve no fim: o texto visível da página, ou linhas de uma lista (seletores CSS). */
export type ReadSpec =
  | { kind: "text"; maxLines: number }
  | { kind: "rows"; rows: string; fields: Record<string, string>; limit: number };

export interface JevTool {
  version: typeof TOOL_VERSION;
  name: string;
  /** O objetivo do `act` que a gravou: diz o que ela faz. */
  goal: string;
  startUrl: string;
  authority: "read";
  /** Os nomes das entradas (`--fill` da gravação viram `--input` da execução). */
  inputs: string[];
  steps: ToolStep[];
  read: ReadSpec;
  createdAt: string;
}

// ── Leitura apenas ──────────────────────────────────────────────

/** Um controle que muda alguma coisa no site. Uma ferramenta de leitura não grava um toque nele. */
const WRITE_CONTROL = /\b(salvar|gravar|enviar|submeter|comprar|finalizar|confirmar|pagar|excluir|apagar|remover|deletar|publicar|cadastrar|assinar|inscrever|adicionar|criar|atualizar|cancelar pedido|reservar|agendar|save|submit|send|buy|checkout|pay|delete|remove|publish|confirm|order|sign up|subscribe|add to (cart|bag)|create|update|book|reserve)\b/i;
/** Fechar um aviso que cobre a página: se ele não aparecer na próxima vez, o passo é pulado. */
const DISMISS_CONTROL = /^((aceitar|aceito|accept|allow|permitir|rejeitar|reject|recusar|decline)( (todos|tudo|all))?( (os )?cookies)?|ok|entendi|got it|fechar|close|dispensar|dismiss|agora n[ãa]o|not now|continuar sem aceitar|×|x)$/i;
const SECRET_FIELD = /\b(senha|password|passcode|pin|c[óo]digo|code|otp|token|cvv|cvc|cart[ãa]o|card)\b/i;

export function writeRisk(el: PageElement): boolean {
  return WRITE_CONTROL.test(el.name);
}

export function isDismiss(el: PageElement): boolean {
  return (el.role === "button" || el.role === "link") && DISMISS_CONTROL.test(el.name.trim());
}

export function matchOf(el: PageElement): ElementMatch {
  return {
    role: el.role,
    name: el.name,
    ...(el.near ? { near: el.near } : {}),
    ...(el.href ? { href: el.href } : {}),
  };
}

// ── Gravar ──────────────────────────────────────────────────────

export interface Recording {
  startUrl: string | null;
  steps: ToolStep[];
  /** Por que esta gravação não vira ferramenta (vazio = vira). */
  problems: string[];
}

/**
 * Embrulha as ações do piloto e anota cada uma como um passo reproduzível. Não muda o que o piloto faz: só observa.
 * `fills` são os `--fill` do `act` (o valor digitado vira a entrada de mesmo nome, nunca fica gravado).
 */
export function recordingDeps<D extends PilotDeps>(deps: D, fills: [string, string][]): { deps: D; recording: () => Recording } {
  let lastPage: ParsedPage | null = null;
  // A página inteira (o piloto a lê para achar um link exato fora da janela) e pode tocar num ref dela.
  let lastAll: ParsedPage | null = null;
  let startUrl: string | null = null;
  const steps: ToolStep[] = [];
  const problems: string[] = [];
  const elementOf = (ref: string): PageElement | null =>
    lastPage?.elements.find((e) => e.ref === ref) ?? lastAll?.elements.find((e) => e.ref === ref) ?? null;
  const valueOf = (text: string): ToolValue => {
    const fill = fills.find(([, value]) => value === text);
    return fill ? { param: fill[0] } : { literal: text };
  };
  const remember = (snapshot: string): string => {
    lastPage = parseSnapshot(snapshot);
    if (startUrl === null && lastPage.url) startUrl = lastPage.url;
    return snapshot;
  };
  const wrapped: D = {
    ...deps,
    snapshot: async () => remember(await deps.snapshot()),
    ...(deps.snapshotAll
      ? {
          snapshotAll: async () => {
            const text = await deps.snapshotAll!();
            lastAll = parseSnapshot(text);
            return text;
          },
        }
      : {}),
    click: async (ref, navigates) => {
      const el = elementOf(ref);
      if (!el) problems.push(`um clique em ${ref} sem o elemento na leitura anterior`);
      else if (!el.name.trim()) problems.push(`um clique num ${el.role} sem nome (não dá para achá-lo de novo)`);
      else if (writeRisk(el) && !isDismiss(el)) problems.push(`um clique em ${el.role} "${el.name}", que muda o site (a ferramenta é só de leitura)`);
      else steps.push({ op: "click", match: matchOf(el), ...(isDismiss(el) ? { optional: true } : {}) });
      return deps.click(ref, navigates);
    },
    type: async (ref, text, submit) => {
      const el = elementOf(ref);
      const value = valueOf(text);
      if (!el) problems.push(`digitou em ${ref} sem o elemento na leitura anterior`);
      else if (SECRET_FIELD.test(el.name)) problems.push(`digitou no campo "${el.name}", que parece senha ou código (uma ferramenta não guarda nem pede segredo)`);
      else if (!el.name.trim()) problems.push(`digitou num ${el.role} sem nome`);
      else if ("literal" in value) problems.push(`digitou em "${el.name}" um texto que não veio de um --fill`);
      else steps.push({ op: "type", match: matchOf(el), value, submit: !!submit });
      return deps.type(ref, text, submit);
    },
    select: async (ref, option) => {
      const el = elementOf(ref);
      if (!el || !el.name.trim()) problems.push(`escolheu numa lista que não dá para achar de novo (${ref})`);
      else steps.push({ op: "select", match: matchOf(el), value: valueOf(option) });
      return deps.select(ref, option);
    },
    scroll: async () => {
      steps.push({ op: "scroll" });
      return deps.scroll();
    },
    ...(deps.clickAt
      ? {
          clickAt: async (x: number, y: number, second?: boolean) => {
            problems.push("um toque por foto (um ponto da tela não é reproduzível)");
            return deps.clickAt!(x, y, second);
          },
        }
      : {}),
  };
  return { deps: wrapped, recording: () => ({ startUrl, steps: [...steps], problems: [...problems] }) };
}

/** `--read`: `text` (padrão), `text:80` ou `rows:<seletor das linhas>|campo=<seletor>|campo=<seletor>`. Pura. */
export function parseReadSpec(raw: string | undefined): ReadSpec {
  const text = raw?.trim() ?? "";
  if (text === "" || text === "text") return { kind: "text", maxLines: DEFAULT_TEXT_LINES };
  const lines = /^text:(\d+)$/.exec(text);
  if (lines) return { kind: "text", maxLines: Math.min(500, Math.max(1, Number(lines[1]))) };
  if (text.startsWith("rows:")) {
    const [rows, ...parts] = text.slice(5).split("|").map((p) => p.trim());
    if (!rows) throw new Error("--read rows: precisa do seletor das linhas: rows:<seletor>|campo=<seletor>");
    const fields: Record<string, string> = {};
    let limit = 50;
    for (const part of parts) {
      const at = part.indexOf("=");
      if (at <= 0) throw new Error(`--read rows: "${part}" não é campo=seletor`);
      const key = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (key === "limit") limit = Math.min(MAX_ROWS, Math.max(1, Number(value) || 50));
      else fields[key] = value;
    }
    if (Object.keys(fields).length === 0) throw new Error("--read rows: precisa de pelo menos um campo=seletor");
    return { kind: "rows", rows, fields, limit };
  }
  throw new Error(`--read não entende "${text}": use text, text:<linhas> ou rows:<seletor>|campo=<seletor>`);
}

/** A ferramenta a partir da gravação, ou por que não dá. Pura. */
export function toolFrom(
  name: string,
  goal: string,
  rec: Recording,
  fills: [string, string][],
  read: ReadSpec,
  now: Date = new Date()
): { tool: JevTool } | { problems: string[] } {
  const problems = [...rec.problems];
  if (!TOOL_NAME.test(name)) problems.push(`o nome "${name}" não serve: comece com letra minúscula e use só minúsculas, dígitos e _`);
  if (!rec.startUrl || !/^https?:\/\//i.test(rec.startUrl)) problems.push("não sei de que página a gravação começou");
  if (problems.length > 0) return { problems };
  const used = new Set(rec.steps.flatMap((s) => ("value" in s && "param" in s.value ? [s.value.param] : [])));
  return {
    tool: {
      version: TOOL_VERSION,
      name,
      goal,
      startUrl: rec.startUrl!,
      authority: "read",
      inputs: fills.map(([key]) => key).filter((key) => used.has(key)),
      steps: rec.steps,
      read,
      createdAt: now.toISOString(),
    },
  };
}

// ── Reproduzir ──────────────────────────────────────────────────

const fold = (text: string | undefined): string =>
  (text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** O elemento da leitura de agora que corresponde ao gravado, ou por que não há um só. Pura. */
export function resolveMatch(page: ParsedPage, match: ElementMatch): { ref: string } | { error: string } {
  const sameRole = page.elements.filter((e) => e.role === match.role);
  let found = sameRole.filter((e) => fold(e.name) === fold(match.name));
  if (found.length === 0 && match.href) found = sameRole.filter((e) => e.href === match.href);
  if (found.length === 0) return { error: `não achei ${match.role} "${match.name}" na página` };
  if (found.length > 1 && match.href) {
    const byHref = found.filter((e) => e.href === match.href);
    if (byHref.length > 0) found = byHref;
  }
  if (found.length > 1 && match.near) {
    const byNear = found.filter((e) => fold(e.near) === fold(match.near));
    if (byNear.length > 0) found = byNear;
  }
  // Cópias do mesmo controle (o menu no topo e no rodapé) levam ao mesmo lugar: vale o primeiro.
  const sameTarget = found.every((e) => e.href === found[0].href && fold(e.near) === fold(found[0].near));
  if (found.length > 1 && !sameTarget) return { error: `${found.length} elementos ${match.role} "${match.name}" e nada que distinga o gravado` };
  return { ref: found[0].ref };
}

export interface ToolRunDeps {
  navigate: (url: string) => Promise<void>;
  /** A página INTEIRA (fora da janela também): o elemento pode estar mais abaixo. */
  snapshot: () => Promise<string>;
  click: (ref: string, navigates?: boolean) => Promise<unknown>;
  type: (ref: string, text: string, submit?: boolean) => Promise<unknown>;
  select: (ref: string, value: string) => Promise<unknown>;
  scroll: () => Promise<unknown>;
  /** Roda o código de página (`readRowsCode`) e devolve o resultado. */
  evaluate: (code: string) => Promise<unknown>;
}

export interface ToolRunResult {
  ok: boolean;
  /** O que cada passo fez, em ordem. */
  done: string[];
  /** As linhas da lista (`rows`) ou o texto da página (`text`). */
  data: Record<string, string | null>[] | string[] | null;
  error?: string;
  ms: number;
}

/** As entradas contra as que a ferramenta declara: falta ou sobra é erro, antes de tocar em nada. Pura. */
export function checkInputs(tool: JevTool, inputs: Record<string, string>): string | null {
  const missing = tool.inputs.filter((k) => !(k in inputs));
  const extra = Object.keys(inputs).filter((k) => !tool.inputs.includes(k));
  if (missing.length > 0) return `faltam entradas: ${missing.map((k) => `--input ${k}=…`).join(", ")}`;
  if (extra.length > 0) return `entradas que a ferramenta não usa: ${extra.join(", ")} (ela usa: ${tool.inputs.join(", ") || "nenhuma"})`;
  return null;
}

function valueText(value: ToolValue, inputs: Record<string, string>): string {
  return "param" in value ? inputs[value.param] : value.literal;
}

function describe(step: ToolStep): string {
  if (step.op === "scroll") return "rolou a página";
  const target = `${step.match.role} "${step.match.name}"`;
  if (step.op === "click") return `clicou ${target}`;
  if (step.op === "type") return `digitou ${"param" in step.value ? `«${step.value.param}»` : "o texto fixo"} em ${target}${step.submit ? " e enviou" : ""}`;
  return `escolheu ${"param" in step.value ? `«${step.value.param}»` : `"${step.value.literal}"`} em ${target}`;
}

/** Refaz o caminho gravado e lê a página. Sem o Jev: um passo que não acha o seu elemento PARA, com o porquê. */
export async function runTool(tool: JevTool, inputs: Record<string, string>, deps: ToolRunDeps, now: () => number = Date.now): Promise<ToolRunResult> {
  const started = now();
  const done: string[] = [];
  const fail = (error: string): ToolRunResult => ({ ok: false, done, data: null, error, ms: now() - started });
  const bad = checkInputs(tool, inputs);
  if (bad) return fail(bad);

  await deps.navigate(tool.startUrl);
  done.push(`abriu ${tool.startUrl}`);
  for (const [index, step] of tool.steps.entries()) {
    if (step.op === "scroll") {
      await deps.scroll();
      done.push(describe(step));
      continue;
    }
    const page = parseSnapshot(await deps.snapshot());
    const hit = resolveMatch(page, step.match);
    if ("error" in hit) {
      if (step.op === "click" && step.optional) {
        done.push(`pulou: ${describe(step)} (o aviso não apareceu desta vez)`);
        continue;
      }
      return fail(`passo ${index + 1} de ${tool.steps.length}: ${hit.error}. A página mudou desde a gravação: grave de novo com \`ags portal act … --save ${tool.name} --replace\`.`);
    }
    if (step.op === "click") {
      const el = page.elements.find((e) => e.ref === hit.ref);
      await deps.click(hit.ref, !!el?.href);
    } else if (step.op === "type") {
      await deps.type(hit.ref, valueText(step.value, inputs), step.submit);
    } else {
      await deps.select(hit.ref, valueText(step.value, inputs));
    }
    done.push(describe(step));
  }

  if (tool.read.kind === "text") {
    const page = parseSnapshot(await deps.snapshot());
    return { ok: true, done, data: page.text.slice(0, tool.read.maxLines), ms: now() - started };
  }
  const answer = (await deps.evaluate(readRowsCode(tool.read))) as ReadRowsAnswer;
  if (answer.error) return fail(`a leitura da lista falhou: ${answer.error}`);
  return { ok: true, done, data: answer.records ?? [], ms: now() - started };
}

/** O relatório de uma execução, para o agente. Pura. */
export function formatRun(tool: JevTool, result: ToolRunResult): string {
  const head = result.ok
    ? `Ferramenta ${tool.name}: ok em ${(result.ms / 1000).toFixed(1)} s, sem o Jev (${tool.steps.length} passo(s) gravados).`
    : `Ferramenta ${tool.name}: FALHOU em ${(result.ms / 1000).toFixed(1)} s. ${result.error}`;
  const steps = result.done.map((d, i) => `${i + 1}. ${d}`).join("\n");
  const data = result.data === null ? "" : `\n\nRESULTADO (${tool.read.kind === "rows" ? `${result.data.length} linha(s)` : "texto visível da página"}):\n${JSON.stringify(result.data, null, 2)}`;
  return `${head}\n\nPassos:\n${steps}${data}`;
}

/** O que a gravação virou, para o relatório do `act`. Pura. */
export function formatSaved(tool: JevTool): string {
  const inputs = tool.inputs.length > 0 ? tool.inputs.map((k) => ` --input ${k}=…`).join("") : "";
  return `FERRAMENTA SALVA: ${tool.name} (${tool.steps.length} passo(s), só leitura, lê ${tool.read.kind === "rows" ? "uma lista" : "o texto da página"}). Rode sem o Jev com: ags portal run <portal> ${tool.name}${inputs}`;
}

/** Por que a gravação não virou ferramenta. Pura. */
export function formatNotSaved(name: string, why: string[]): string {
  return `FERRAMENTA NÃO SALVA (${name}):\n${why.map((w) => `- ${w}`).join("\n")}`;
}

// ── Ler linhas de uma lista (código de página) ──────────────────

export interface ReadRowsAnswer {
  records?: Record<string, string | null>[];
  error?: string;
}

/**
 * Código que roda na página e lê as linhas de uma lista: só o texto que uma pessoa vê (nada escondido, de script ou de
 * estilo). Adaptado de `visibleTextPage`/`readRows` do Pomerado (`typescript/src/browser/visible-text.ts`,
 * Copyright (c) 2026 Pomerado AI, Inc., licença MIT): aqui recebe seletores CSS em vez de locators do Playwright, e só o
 * modo «o que se vê».
 */
export function readRowsCode(spec: Extract<ReadSpec, { kind: "rows" }>): string {
  return `(${READ_ROWS_PAGE})(${JSON.stringify(spec)})`;
}

const READ_ROWS_PAGE = String.raw`(spec) => {
  const normalize = (text) => text
    .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[ \t\v\f\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" ");
  const styles = new Map();
  const style = (el) => { let c = styles.get(el); if (c === undefined) styles.set(el, (c = getComputedStyle(el))); return c; };
  const parentOf = (node) => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const skipped = (el) => {
    const name = el.localName;
    if (name === "script" || name === "style" || name === "noscript" || name === "template") return true;
    return el.namespaceURI === "http://www.w3.org/2000/svg" && (name === "title" || name === "desc");
  };
  const clipsOverflow = (v) => v === "hidden" || v === "clip";
  const visuallyHidden = (el, c) => {
    if (c.display === "contents") return false;
    if (parseFloat(c.textIndent) <= -999) return true;
    const positioned = c.position === "absolute" || c.position === "fixed";
    const clipped = clipsOverflow(c.overflowX) && clipsOverflow(c.overflowY);
    if (!clipped && !positioned) return false;
    const r = el.getBoundingClientRect();
    if (clipped && r.width <= 1 && r.height <= 1) return true;
    if (!positioned) return false;
    const fixed = c.position === "fixed";
    const x = fixed ? 0 : scrollX, y = fixed ? 0 : scrollY;
    const w = fixed ? innerWidth : document.documentElement.scrollWidth;
    const h = fixed ? innerHeight : document.documentElement.scrollHeight;
    const before = (end, size) => end < 0 || (size > 0 && end <= 0);
    return before(r.right + x, r.width) || before(r.bottom + y, r.height) || r.left + x >= w || r.top + y >= h;
  };
  const childrenOf = (node) => node.shadowRoot?.childNodes ?? (node.localName === "slot" ? node.assignedNodes({ flatten: true }) : node.childNodes);
  const hasArea = (rects) => [...rects].some((r) => r.width > 0 || r.height > 0);
  const showsBox = (el) => {
    if (style(el).display !== "contents")
      return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && hasArea(el.getClientRects());
    return [...childrenOf(el)].some((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) return !skipped(child) && !visuallyHidden(child, style(child)) && showsBox(child);
      if (child.nodeType !== Node.TEXT_NODE || child.data.trim() === "") return false;
      const p = parentOf(child);
      if (p === null || style(p).visibility !== "visible") return false;
      const range = document.createRange();
      range.selectNodeContents(child);
      return hasArea(range.getClientRects());
    });
  };
  const rendered = (el, stop) => {
    if (!el.isConnected || el.closest("[hidden], template") !== null) return false;
    if (!showsBox(el)) return false;
    for (let at = el; at !== null && at !== stop; at = parentOf(at)) {
      if (at.nodeType !== Node.ELEMENT_NODE) break;
      if (skipped(at) || visuallyHidden(at, style(at))) return false;
      if (at === document.documentElement) break;
    }
    return true;
  };
  const inline = (d) => d.startsWith("inline") || d === "contents" || d.startsWith("ruby");
  const read = (root) => {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const p = parentOf(node);
        if (p === null || style(p).visibility !== "visible") return;
        parts.push(/^(pre|break-spaces)/u.test(style(p).whiteSpace) ? node.data : node.data.replace(/[\t\n\r\f ]+/gu, " "));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node !== root) {
        if (skipped(node)) return;
        const c = style(node);
        if (c.display === "none" || parseFloat(c.opacity) === 0 || visuallyHidden(node, c)) return;
      }
      if (node.localName === "br") { parts.push("\n"); return; }
      const d = style(node).display;
      const sep = d === "table-cell" ? " " : inline(d) ? "" : "\n";
      parts.push(sep);
      if (style(node).contentVisibility !== "hidden") for (const child of childrenOf(node)) visit(child);
      parts.push(sep);
    };
    visit(root);
    return normalize(parts.join(""));
  };
  let all;
  try { all = [...document.querySelectorAll(spec.rows)]; } catch (e) { return { error: "seletor das linhas inválido: " + spec.rows }; }
  if (all.length === 0) return { error: "nenhum elemento casa com " + spec.rows };
  const rows = all.filter((el) => rendered(el, null)).slice(0, spec.limit);
  const records = [];
  for (const row of rows) {
    const record = {};
    for (const [name, selector] of Object.entries(spec.fields)) {
      let candidates;
      try { candidates = selector === ":scope" ? [row] : [...row.querySelectorAll(selector)]; }
      catch (e) { return { error: "seletor inválido no campo " + name + ": " + selector }; }
      const match = candidates.find((el) => el === row || rendered(el, row));
      const value = match === undefined ? null : read(match);
      record[name] = value !== null && value.length > 4000 ? value.slice(0, 4000) : value;
    }
    records.push(record);
  }
  return { records };
}`;

/** As entradas da execução: `campo=valor` repetível, igual ao `--fill`. Pura. */
export function parseInputs(raw: string[]): Record<string, string> {
  return Object.fromEntries(parseFills(raw));
}
