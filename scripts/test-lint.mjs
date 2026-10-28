// Lint dos testes: pega o que deixa a suíte lenta, instável ou silenciosamente menor.
//
//   bun run check:test-lint                          # falha só com violação NOVA
//   bun run check:test-lint -- --todas               # lista todas, inclusive as do baseline
//   bun run check:test-lint -- --update-baseline     # regrava o baseline com a contagem atual
//
// Regras (em testes TS `*.test.ts(x)` e em código de teste Rust):
// - espera-real: timer ou sleep real acima de LIMITE_MS. Use fake timers (`vi.useFakeTimers()`,
//   `tokio::time::pause()`) ou espere o evento.
// - polling: laço que dorme esperando algo mudar. Espere o evento, o canal ou a promessa.
// - skip-sem-motivo: `it.skip`/`describe.skip`/`xit`/`#[ignore]` sem `// quarantine: <motivo ou #issue>`.
// - supressao-sem-motivo: `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `#[allow(...)]` sem motivo.
//
// As violações que já existiam ficam em `scripts/test-lint-baseline.json` (contagem por arquivo e
// regra). O check falha quando uma contagem passa do baseline. Corrigiu uma? Rode com
// `--update-baseline` e commite o baseline menor. Nunca use o `--update-baseline` para engolir
// uma violação nova.
//
// Antes de procurar os padrões, apaga strings e comentários (TS: tokens do @babel/parser, o mesmo
// do `check:babel`; Rust: um lexer pequeno),
// para que um teste que fala de `setTimeout` numa string não conte.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "@babel/parser";

/** Acima disso, um atraso literal é espera real (ms). `setTimeout(r, 0)` para esvaziar a fila passa. */
export const LIMITE_MS = 10;

export const REGRAS = {
  "espera-real": "espera real no teste: use fake timers (vi.useFakeTimers / tokio::time::pause) ou espere o evento",
  polling: "laço que dorme esperando algo mudar: espere o evento, o canal ou a promessa",
  "skip-sem-motivo": "teste pulado sem motivo: anote `// quarantine: <motivo ou #issue>` na linha ou na de cima",
  "supressao-sem-motivo": "supressão sem motivo: escreva o porquê (ex.: `// @ts-expect-error <motivo>`, `eslint-disable-line regra -- <motivo>`, `// <motivo>` acima do `#[allow]`)",
};

const QUARENTENA = /quarantine:\s*\S{2,}/i;

// ---------------------------------------------------------------------------------------------
// Lexers: devolvem o código com strings, regex e comentários trocados por espaços (as posições e
// as quebras de linha ficam iguais) e o texto dos comentários de cada linha.

/** @param {string} src @param {"ts"|"rs"} lang @returns {{ code: string, comments: string[] }} */
export function lex(src, lang) {
  return lang === "ts" ? lexTs(src) : lexRust(src);
}

/** Apaga `[from, to)` em `out`, mantendo as quebras de linha. */
const apagar = (src, out, from, to) => {
  for (let k = from; k < to; k++) if (src[k] !== "\n" && src[k] !== "\r") out[k] = " ";
};

/** Guarda o texto de `[from, to)` em `comments`, linha a linha, e apaga do código. */
const comentar = (src, out, comments, line, from, to) => {
  let start = from;
  for (let k = from; k <= to; k++) {
    if (k === to || src[k] === "\n") {
      comments[line] = (comments[line] ?? "") + src.slice(start, k);
      if (k < to) { line++; start = k + 1; }
    } else out[k] = " ";
  }
};

// TS/TSX: os tokens do mesmo parser do `check:babel` (JSX, regex e template sem adivinhação).
function lexTs(src) {
  const ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"], tokens: true, errorRecovery: true });
  const out = src.split("");
  const comments = [];
  for (const t of ast.tokens) {
    const label = typeof t.type === "string" ? t.type : t.type.label;
    if (label === "string" || label === "regexp") apagar(src, out, t.start + 1, label === "regexp" ? src.lastIndexOf("/", t.end - 1) : t.end - 1);
    else if (label === "template" || label === "jsxText") apagar(src, out, t.start, t.end);
  }
  for (const c of ast.comments) comentar(src, out, comments, c.loc.start.line - 1, c.start, c.end);
  return { code: out.join(""), comments };
}

// Rust: comentários (aninhados), "..", r#".."#, b"..", e literais de char ('{' não é chave).
function lexRust(src) {
  const out = src.split("");
  const comments = [];
  const n = src.length;
  let line = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (src[k] === "\n") line++;
    apagar(src, out, from, to);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && (d === "/" || d === "*")) {
      let j = i + 2;
      if (d === "/") while (j < n && src[j] !== "\n") j++;
      else {
        for (let nest = 1; j < n && nest > 0; ) {
          if (src[j] === "*" && src[j + 1] === "/") { nest--; j += 2; }
          else if (src[j] === "/" && src[j + 1] === "*") { nest++; j += 2; }
          else j++;
        }
      }
      comentar(src, out, comments, line, i, j);
      for (let k = i; k < j; k++) if (src[k] === "\n") line++;
      i = j;
      continue;
    }
    const identAntes = i > 0 && /[A-Za-z0-9_]/.test(src[i - 1]);
    const raw = !identAntes && (c === "r" || c === "b") ? /^(?:br|r)(#*)"/.exec(src.slice(i, i + 40)) : null;
    if (raw) {
      const fim = `"${raw[1]}`;
      const abre = i + raw[0].length;
      const j = src.indexOf(fim, abre);
      blank(abre, j < 0 ? n : j);
      i = j < 0 ? n : j + fim.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const ch = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/.exec(src.slice(i, i + 16));
      if (ch) {
        blank(i + 1, i + ch[0].length - 1);
        i += ch[0].length;
        continue;
      }
    }
    i++;
  }
  return { code: out.join(""), comments };
}

// ---------------------------------------------------------------------------------------------
// Ajudantes sobre o código já sem strings.

const linhaDe = (code) => {
  const starts = [0];
  for (let k = 0; k < code.length; k++) if (code[k] === "\n") starts.push(k + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
};

/** Índice do fechamento que casa com a abertura em `open` (ou -1). */
function fecha(code, open) {
  const a = code[open];
  const b = a === "(" ? ")" : a === "[" ? "]" : "}";
  let nivel = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === a) nivel++;
    else if (code[k] === b && --nivel === 0) return k;
  }
  return -1;
}

/** Argumentos de nível zero da chamada cujo `(` está em `open`. */
function argumentos(code, open) {
  const end = fecha(code, open);
  if (end < 0) return [];
  const args = [];
  let nivel = 0;
  let start = open + 1;
  for (let k = open + 1; k < end; k++) {
    const c = code[k];
    if ("([{".includes(c)) nivel++;
    else if (")]}".includes(c)) nivel--;
    else if (c === "," && nivel === 0) { args.push(code.slice(start, k).trim()); start = k + 1; }
  }
  const last = code.slice(start, end).trim();
  if (last) args.push(last);
  return args;
}

/** `500`, `1_000`, `2 * 1000` → número; o resto → null. */
function numero(expr) {
  if (!expr || !/^[\d_.\s*]+$/.test(expr)) return null;
  const partes = expr.split("*").map((p) => Number(p.replace(/_/g, "").trim()));
  if (partes.some((p) => !Number.isFinite(p))) return null;
  return partes.reduce((a, b) => a * b, 1);
}

/** Comentário na própria linha ou nas linhas só de comentário logo acima (até 3) casa com `re`? */
function motivoPerto(comments, codeLines, ln, re) {
  if (re.test(comments[ln] ?? "")) return true;
  for (let k = ln - 1; k >= 0 && k >= ln - 3; k--) {
    if (codeLines[k].trim() !== "" || !comments[k]) return false;
    if (re.test(comments[k])) return true;
  }
  return false;
}

/** Laços do código: posição da palavra-chave e o intervalo do corpo. */
function lacos(code, lang) {
  const found = [];
  const re = lang === "ts" ? /\b(while|for)\s*\(|\bdo\s*\{/g : /\b(loop|while|for)\b/g;
  for (let m; (m = re.exec(code)); ) {
    let bodyStart;
    let bodyEnd;
    if (lang === "ts") {
      if (m[0].startsWith("do")) {
        bodyStart = m.index + m[0].length - 1;
        bodyEnd = fecha(code, bodyStart);
      } else {
        const headerEnd = fecha(code, m.index + m[0].length - 1);
        if (headerEnd < 0) continue;
        let k = headerEnd + 1;
        while (k < code.length && /\s/.test(code[k])) k++;
        if (code[k] === "{") { bodyStart = k; bodyEnd = fecha(code, k); }
        else { bodyStart = k; bodyEnd = code.indexOf(";", k); }
      }
    } else {
      // Rust: o corpo é a primeira `{` fora de parênteses depois da palavra-chave.
      let k = m.index + m[0].length;
      let nivel = 0;
      for (; k < code.length; k++) {
        const c = code[k];
        if (c === "(" || c === "[") nivel++;
        else if (c === ")" || c === "]") nivel--;
        else if (c === ";" && nivel === 0) { k = -1; break; }
        else if (c === "{" && nivel === 0) break;
      }
      if (k < 0 || k >= code.length) continue;
      // `impl Trait for Tipo {` e `for<'a>` não são laço.
      if (m[1] === "for" && !/\bin\b/.test(code.slice(m.index + 3, k))) continue;
      bodyStart = k;
      bodyEnd = fecha(code, k);
    }
    if (bodyEnd > bodyStart) found.push({ at: m.index, bodyStart, bodyEnd });
  }
  return found;
}

/** Marca, uma vez por laço, o laço mais interno que contém cada espera. */
function polling(code, esperas, lang, linha, push) {
  const loops = lacos(code, lang);
  const marcados = new Set();
  for (const pos of esperas) {
    let dentro = null;
    for (const l of loops) if (l.bodyStart <= pos && pos <= l.bodyEnd && (!dentro || l.bodyStart > dentro.bodyStart)) dentro = l;
    if (dentro && !marcados.has(dentro)) {
      marcados.add(dentro);
      push("polling", linha(dentro.at));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// TypeScript

/** @param {string} src @returns {{ regra: string, linha: number, detalhe: string }[]} */
export function lintTs(src) {
  const { code, comments } = lex(src, "ts");
  const codeLines = code.split("\n");
  const linha = linhaDe(code);
  /** @type {{ regra: string, linha: number, detalhe: string }[]} */
  const out = [];
  const push = (regra, ln, detalhe = "") => out.push({ regra, linha: ln + 1, detalhe });
  const fake = /\buseFakeTimers\s*\(/.test(code);

  // Esperas reais (também alimentam o polling).
  const esperas = [];
  for (const m of code.matchAll(/\b(setTimeout|setInterval)\s*\(/g)) {
    const args = argumentos(code, m.index + m[0].length - 1);
    // `setTimeout(fn, ms)` ou o `await setTimeout(ms)` de `node:timers/promises`.
    const ms = numero(args.length === 1 ? args[0] : args[1]);
    if (ms === null || ms <= LIMITE_MS) continue;
    esperas.push(m.index);
    if (!fake) push("espera-real", linha(m.index), `${m[1]} de ${ms} ms`);
  }
  for (const m of code.matchAll(/(^|[^.\w$]|\bBun\.)(sleep|delay|wait|pause|esperar|dormir)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = argumentos(code, open);
    const ms = numero(args[0]);
    if (args.length !== 1 || ms === null || ms <= LIMITE_MS) continue;
    // Definição (`function sleep(ms)`) não é chamada.
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, open - 40), m.index + m[1].length))) continue;
    esperas.push(open);
    if (!fake) push("espera-real", linha(open), `${m[2]}(${ms})`);
  }
  // Laço que espera o relógio de parede: `while (Date.now() < fim)`.
  for (const l of lacos(code, "ts")) {
    const header = code.slice(l.at, l.bodyStart);
    if (/\b(?:Date\.now|performance\.now)\s*\(/.test(header)) esperas.push(l.bodyStart);
  }
  polling(code, esperas, "ts", linha, push);

  // Testes pulados.
  for (const m of code.matchAll(/\b(?:it|test|describe|suite|bench)(?:\s*\.\s*(?:concurrent|sequential|each))*\s*\.\s*(skip|skipIf)\b|\bx(?:it|test|describe)\s*\(/g)) {
    const ln = linha(m.index);
    if (!motivoPerto(comments, codeLines, ln, QUARENTENA)) push("skip-sem-motivo", ln, m[0].replace(/\s+/g, "").replace(/\($/, ""));
  }

  // Supressões: o motivo vem depois da diretiva.
  comments.forEach((text, ln) => {
    if (!text) return;
    const ts = /@ts-(ignore|expect-error|nocheck)\b(.*)/.exec(text);
    if (ts && !/\p{L}{3,}/u.test(ts[2].replace(/^[\s:–—-]+/, ""))) push("supressao-sem-motivo", ln, `@ts-${ts[1]}`);
    const lint = /\b(eslint|oxlint)-(disable(?:-next-line|-line)?|enable)\b(.*)/.exec(text);
    if (lint && lint[2] !== "enable" && !/--\s*\p{L}{3,}/u.test(lint[3])) push("supressao-sem-motivo", ln, `${lint[1]}-${lint[2]}`);
    const biome = /\bbiome-ignore\b(.*)/.exec(text);
    if (biome && !/:\s*\p{L}{3,}/u.test(biome[1])) push("supressao-sem-motivo", ln, "biome-ignore");
  });
  return out.sort((a, b) => a.linha - b.linha);
}

// ---------------------------------------------------------------------------------------------
// Rust

const CFG_TEST = /#\[cfg\(([^\]]*)\)\]/g;
const ehCfgTest = (inner) => /\btest\b/.test(inner) && !/\bnot\s*\(\s*test\b/.test(inner);

/** Duração em ms de `Duration::from_millis(50)` & cia.; null se não for literal. */
function duracao(expr) {
  const m = /Duration::from_(millis|secs|micros|nanos|secs_f32|secs_f64)\s*\(\s*([\d_.]+)\s*\)/.exec(expr);
  if (!m) return null;
  const v = Number(m[2].replace(/_/g, ""));
  return m[1].startsWith("secs") ? v * 1000 : m[1] === "millis" ? v : m[1] === "micros" ? v / 1000 : v / 1e6;
}

/**
 * Intervalos `[início, fim)` do código de teste. Arquivo inteiro de teste → tudo; senão, os
 * blocos `#[cfg(test)] mod x { ... }`.
 */
function regioesDeTeste(code, todoArquivo) {
  if (todoArquivo) return [[0, code.length]];
  const regioes = [];
  for (const m of code.matchAll(CFG_TEST)) {
    if (!ehCfgTest(m[1])) continue;
    const resto = code.slice(m.index + m[0].length);
    const mod = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/.exec(resto);
    if (!mod) continue;
    const open = m.index + m[0].length + mod[0].length - 1;
    const end = fecha(code, open);
    if (end > open) regioes.push([m.index, end + 1]);
  }
  return regioes;
}

/**
 * @param {string} src
 * @param {{ todoArquivo?: boolean }} [opts] `todoArquivo`: o arquivo inteiro é módulo de teste.
 */
export function lintRust(src, opts = {}) {
  const { code, comments } = lex(src, "rs");
  const codeLines = code.split("\n");
  const srcLines = src.split("\n");
  const linha = linhaDe(code);
  const out = [];
  const push = (regra, ln, detalhe = "") => out.push({ regra, linha: ln + 1, detalhe });
  const regioes = regioesDeTeste(code, !!opts.todoArquivo);
  if (regioes.length === 0) return out;
  const dentro = (pos) => regioes.some(([a, b]) => a <= pos && pos < b);
  const tempoPausado = /\btime::pause\s*\(|start_paused\s*=\s*true/.test(code);

  const esperas = [];
  for (const m of code.matchAll(/\b(?:(?:std::)?thread::sleep|(?:tokio::)?time::sleep|(?<![:.\w])sleep)\s*\(/g)) {
    if (!dentro(m.index)) continue;
    if (/\bfn\s+$/.test(code.slice(Math.max(0, m.index - 10), m.index))) continue;
    const tokio = /time::sleep/.test(m[0]) && !/thread/.test(m[0]);
    const open = m.index + m[0].length - 1;
    const end = fecha(code, open);
    // A duração é número: lê do original (no `code` só os números sobrevivem, mas é igual).
    const ms = duracao(src.slice(open, end + 1));
    if (ms !== null && ms <= LIMITE_MS) continue;
    if (tokio && tempoPausado) continue;
    esperas.push(m.index);
    push("espera-real", linha(m.index), ms === null ? "duração não literal" : `${ms} ms`);
  }
  polling(code, esperas, "rs", linha, push);

  for (const m of code.matchAll(/#\[ignore\b/g)) {
    if (!dentro(m.index)) continue;
    const ln = linha(m.index);
    const comMotivo = /#\[ignore\s*=\s*"\s*\S/.test(srcLines[ln]);
    if (!comMotivo && !motivoPerto(comments, codeLines, ln, QUARENTENA)) push("skip-sem-motivo", ln, "#[ignore]");
  }

  for (const m of code.matchAll(/#!?\[(allow|expect)\s*\(/g)) {
    if (!dentro(m.index)) continue;
    const ln = linha(m.index);
    const attrEnd = fecha(code, m.index + m[0].length - 1);
    const attr = src.slice(m.index, attrEnd + 1);
    if (/\breason\s*=\s*"\s*\S/.test(attr)) continue;
    if (!motivoPerto(comments, codeLines, ln, /\p{L}{3,}/u)) push("supressao-sem-motivo", ln, `#[${m[1]}]`);
  }
  return out.sort((a, b) => a.linha - b.linha);
}

/**
 * Arquivos de `mod x;` que viram código de teste, já resolvidos: os puxados por `#[cfg(test)]`
 * (inclusive com `#[path]`) ou, com `todos`, qualquer `mod x;` (submódulo de módulo de teste).
 */
export function modulosDeTeste(src, file, { todos = false } = {}) {
  const { code } = lex(src, "rs");
  const raiz = /[\\/](lib|main|mod)\.rs$/.test(file) || /[\\/]bin[\\/][^\\/]+\.rs$/.test(file);
  const base = raiz ? dirname(file) : file.slice(0, -3);
  const found = [];
  for (const m of code.matchAll(/((?:#!?\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?\bmod\s+(\w+)\s*;/g)) {
    const cfgs = [...m[1].matchAll(CFG_TEST)];
    if (!todos && !cfgs.some((a) => ehCfgTest(a[1]))) continue;
    // O caminho é string: no `code` ela está apagada, então lê do original (mesmas posições).
    const path = /#\[path\s*=\s*"([^"]+)"\]/.exec(src.slice(m.index, m.index + m[0].length));
    if (path) found.push(resolve(dirname(file), path[1]));
    else {
      const a = join(base, `${m[2]}.rs`);
      found.push(existsSync(a) ? a : join(base, m[2], "mod.rs"));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Baseline

/** @param {{ arquivo: string, regra: string }[]} violacoes */
export function contar(violacoes) {
  /** @type {Record<string, Record<string, number>>} */
  const counts = {};
  for (const v of violacoes) {
    counts[v.arquivo] ??= {};
    counts[v.arquivo][v.regra] = (counts[v.arquivo][v.regra] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compara a contagem atual com o baseline.
 * `novas`: (arquivo, regra) que passaram do baseline; `encolheu`: as que podem baixar.
 */
export function comparar(atual, baseline) {
  const novas = [];
  const encolheu = [];
  for (const [arquivo, regras] of Object.entries(atual)) {
    for (const [regra, n] of Object.entries(regras)) {
      const antes = baseline[arquivo]?.[regra] ?? 0;
      if (n > antes) novas.push({ arquivo, regra, antes, agora: n });
    }
  }
  for (const [arquivo, regras] of Object.entries(baseline)) {
    for (const [regra, antes] of Object.entries(regras)) {
      const agora = atual[arquivo]?.[regra] ?? 0;
      if (agora < antes) encolheu.push({ arquivo, regra, antes, agora });
    }
  }
  return { novas, encolheu };
}

const ordenado = (counts) => Object.fromEntries(
  Object.keys(counts).sort().map((f) => [f, Object.fromEntries(Object.keys(counts[f]).sort().map((r) => [r, counts[f][r]]))]),
);

// ---------------------------------------------------------------------------------------------
// CLI

function walk(dir, pick, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, pick, acc);
    else if (pick(path)) acc.push(path);
  }
  return acc;
}

/** Varre o repositório em `root` e devolve todas as violações. */
export function varrer(root) {
  const rel = (p) => relative(root, p).split(sep).join("/");
  const violacoes = [];
  for (const file of walk(join(root, "src"), (p) => /\.test\.tsx?$/.test(p))) {
    for (const v of lintTs(readFileSync(file, "utf8"))) violacoes.push({ arquivo: rel(file), ...v });
  }
  const rsFiles = [join(root, "src-tauri", "src"), join(root, "src-tauri", "tests")].flatMap((d) => walk(d, (p) => p.endsWith(".rs")));
  const testFiles = new Set(rsFiles.filter((p) => {
    const r = rel(p);
    return /(^|\/)tests?\.rs$/.test(r) || /_tests?\.rs$/.test(r) || /(^|\/)tests\//.test(r.replace(/^src-tauri\//, ""));
  }));
  const sources = new Map(rsFiles.map((p) => [p, readFileSync(p, "utf8")]));
  for (const [file, src] of sources) for (const m of modulosDeTeste(src, file)) if (sources.has(m)) testFiles.add(m);
  // Submódulos de um módulo de teste também são teste.
  for (const fila = [...testFiles]; fila.length > 0; ) {
    const file = fila.pop();
    for (const m of modulosDeTeste(sources.get(file), file, { todos: true })) {
      if (sources.has(m) && !testFiles.has(m)) { testFiles.add(m); fila.push(m); }
    }
  }
  for (const [file, src] of sources) {
    for (const v of lintRust(src, { todoArquivo: testFiles.has(file) })) violacoes.push({ arquivo: rel(file), ...v });
  }
  return violacoes;
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baselinePath = join(root, "scripts", "test-lint-baseline.json");
  const violacoes = varrer(root);
  const atual = contar(violacoes);
  const fmt = (v) => `  ${v.arquivo}:${v.linha}  [${v.regra}] ${v.detalhe}`;

  if (argv.includes("--update-baseline")) {
    const doc = {
      _leia: "Violações antigas do lint de testes (scripts/test-lint.mjs). Só deve diminuir: corrija e rode `bun run check:test-lint -- --update-baseline`.",
      violacoes: ordenado(atual),
    };
    writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`Baseline regravado: ${violacoes.length} violação(ões) em ${Object.keys(atual).length} arquivo(s).`);
    return 0;
  }

  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")).violacoes ?? {} : {};
  if (argv.includes("--todas")) {
    for (const v of violacoes) console.log(fmt(v));
    console.log(`${violacoes.length} violação(ões) no total.`);
  }
  const { novas, encolheu } = comparar(atual, baseline);
  if (novas.length > 0) {
    console.error(`Lint de testes: ${novas.length} violação(ões) nova(s) além do baseline.\n`);
    for (const nv of novas) {
      console.error(`${nv.arquivo} — ${nv.regra}: ${nv.agora} (baseline ${nv.antes})`);
      console.error(`  ${REGRAS[nv.regra]}`);
      for (const v of violacoes) if (v.arquivo === nv.arquivo && v.regra === nv.regra) console.error(fmt(v));
    }
    console.error("\nCorrija a violação nova. O baseline (scripts/test-lint-baseline.json) só guarda as antigas.");
    return 1;
  }
  if (encolheu.length > 0) {
    console.log(`O baseline pode encolher em ${encolheu.length} entrada(s): rode \`bun run check:test-lint -- --update-baseline\` e commite.`);
  }
  console.log(`Lint de testes ok: ${violacoes.length} violação(ões) antiga(s) no baseline, nenhuma nova.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
