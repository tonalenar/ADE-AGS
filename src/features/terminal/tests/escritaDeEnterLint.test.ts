import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Lint da guarda de escrita (PR08): o Enter que sai do app para um agente só pode vir de `safeWrite.ts` (ou da
 * primitiva do registro que ele usa). Os chamadores pegam `ptyWrite(...)`, `sendKeysToTab(...)` e `.input(...)`
 * com `\r` no argumento. O xterm recebe `input("\r")` e o manda ao PTY, então `.input(` precisa estar no lint:
 * só `ptyWrite(` deixaria o Enter real de fora.
 */

/** Chamadas que escrevem no PTY ou no xterm. */
const CHAMADA = /\b(?:ptyWrite|sendKeysToTab)\s*\(|\.input\s*\(/g;
/** O Enter no código-fonte: `\r` (ou `\\r`), sem letra ou número logo depois (não casa `\rm`). Também `\u000d` e `\x0d`. */
const ENTER = /\\\\?r(?![A-Za-z0-9_])|\\u000[dD]|\\x0[dD]/;

/** Os argumentos da chamada que abre em `open`, com strings respeitadas. Até 600 caracteres. */
function argumentos(src: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < src.length && i < open + 600; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open, open + 600);
}

/** As linhas (1-based) de chamadas que levam um Enter no argumento. Pura. */
export function achaEnters(src: string): { linha: number; texto: string }[] {
  const hits: { linha: number; texto: string }[] = [];
  for (const m of src.matchAll(CHAMADA)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (!ENTER.test(argumentos(src, open))) continue;
    const linha = src.slice(0, m.index ?? 0).split("\n").length;
    hits.push({ linha, texto: src.split("\n")[linha - 1].trim() });
  }
  return hits;
}

/** Os arquivos de app (não de teste) sob `dir`, com o caminho relativo a `src/`. */
function fontes(dir: string, raiz: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome !== "tests" && nome !== "node_modules") out.push(...fontes(caminho, raiz));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(nome) || /\.test\./.test(nome)) continue;
    out.push(caminho.slice(raiz.length));
  }
  return out;
}

/**
 * O que pode ter Enter fora de `safeWrite.ts`, com o motivo. `ocorrencias` é a contagem exata de hits com
 * esse texto no arquivo: um Enter novo com o mesmo texto reprova o lint. Entrada que deixa de casar também reprova.
 */
const PERMITIDOS: { arquivo: string; linha: string; ocorrencias: number; motivo: string }[] = [
  {
    arquivo: "features/terminal/terminalRegistry.ts",
    linha: 'term.input("\\r");',
    ocorrencias: 1,
    motivo: "a única primitiva do Enter do registro. Ela confere a `policy` antes de cada Enter; quem não passa policy é ação da pessoa (chat, Rodar, menu).",
  },
  {
    arquivo: "features/canvas/useTerminalPrompts.ts",
    linha: 'if (needsEnter) window.setTimeout(() => sendKeysToTab(tabId, "\\r"), 200);',
    ocorrencias: 1,
    motivo: "resposta explícita da pessoa a um menu de permissão (painel de Time). Não é envio autônomo.",
  },
];

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

/** Os Enters de fora da guarda que não estão na lista permitida. */
function naoPermitidos(): string[] {
  const achados: string[] = [];
  const usados = new Map<string, number>();
  for (const arquivo of fontes(SRC, SRC)) {
    if (arquivo === "features/terminal/safeWrite.ts") continue;
    const src = readFileSync(join(SRC, arquivo), "utf8");
    for (const hit of achaEnters(src)) {
      const permitido = PERMITIDOS.find((p) => p.arquivo === arquivo && p.linha === hit.texto);
      if (!permitido) {
        achados.push(`${arquivo}:${hit.linha}  ${hit.texto}`);
        continue;
      }
      const chave = `${arquivo}|${hit.texto}`;
      usados.set(chave, (usados.get(chave) ?? 0) + 1);
    }
  }
  for (const p of PERMITIDOS) {
    const n = usados.get(`${p.arquivo}|${p.linha}`) ?? 0;
    if (n !== p.ocorrencias) achados.push(`lista permitida: ${p.arquivo} "${p.linha}" casa ${n} vez(es), esperado ${p.ocorrencias}`);
  }
  return achados;
}

describe("achaEnters (o próprio detector)", () => {
  it("pega Enter em ptyWrite, sendKeysToTab e input do xterm", () => {
    expect(achaEnters(String.raw`ptyWrite(7, "\r");`)).toHaveLength(1);
    expect(achaEnters(String.raw`sendKeysToTab(tabId, "\r");`)).toHaveLength(1);
    expect(achaEnters(String.raw`term.input("\r");`)).toHaveLength(1);
    expect(achaEnters(String.raw`setTimeout(() => term.input("\r"), 80);`)).toHaveLength(1);
    expect(achaEnters(String.raw`ptyWrite(7, "\\r");`)).toHaveLength(1);
  });

  it("não pega tecla de escape, dado do usuário nem \\rm", () => {
    expect(achaEnters(String.raw`sendKeysToTab(tabId, "\u001b");`)).toHaveLength(0);
    expect(achaEnters("ptyWrite(ptyIdRef.current, data);")).toHaveLength(0);
    expect(achaEnters(String.raw`term.input("\rm -rf");`)).toHaveLength(0);
  });

  it("acha o Enter mesmo com parênteses dentro de string", () => {
    expect(achaEnters(String.raw`ptyWrite(7, ")(" + "\r");`)).toHaveLength(1);
  });
});

describe("Enter fora da guarda de escrita", () => {
  it("nenhum arquivo de app manda Enter fora de safeWrite.ts sem estar na lista permitida", () => {
    expect(naoPermitidos()).toEqual([]);
  });
});
