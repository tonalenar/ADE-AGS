import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Lint da guarda de escrita (PR08). Dois tipos de violação:
 *
 * 1. Enter literal (`\r`) num `ptyWrite`, `sendKeysToTab` ou `.input(` fora da primitiva do registro. O xterm
 *    recebe `input("\r")` e o manda ao PTY, então `.input(` precisa estar no lint.
 * 2. Emissor de envio sem política: `sendWhenReady(...)` sem `policy`, ou `pasteIntoTab(..., true, ...)` sem política.
 *    Ele pode mandar Enter numa TUI sem a conferência de pergunta e trabalho. Só os envios que a própria pessoa
 *    dispara ficam na lista (com motivo); o envio do app passa por `sendAutonomous`/`writeToAgent`.
 */

/** Chamadas que escrevem no PTY ou no xterm. */
const CHAMADA = /\b(?:ptyWrite|sendKeysToTab)\s*\(|\.input\s*\(/g;
/** Emissores de envio ao registro de terminais. */
const EMISSOR = /\b(sendWhenReady|pasteIntoTab)\s*\(/g;
/** O Enter no código-fonte: `\r` (ou `\\r`), sem letra ou número logo depois (não casa `\rm`). Também `\u000d` e `\x0d`. */
const ENTER = /\\\\?r(?![A-Za-z0-9_])|\\u000[dD]|\\x0[dD]/;

/** Os argumentos da chamada que abre em `open`, com strings respeitadas. Até 2000 caracteres. */
function argumentos(src: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < src.length && i < open + 2000; i++) {
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
  return src.slice(open, open + 2000);
}

/** Os argumentos de uma chamada (com os parênteses de fora), separados por vírgula no nível de cima. Pura. */
function separaArgumentos(chamada: string): string[] {
  const corpo = chamada.slice(1, -1);
  const partes: string[] = [];
  let depth = 0;
  let quote = "";
  let atual = "";
  for (let i = 0; i < corpo.length; i++) {
    const c = corpo[i];
    if (quote) {
      atual += c;
      if (c === "\\") { atual += corpo[i + 1] ?? ""; i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; atual += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { partes.push(atual.trim()); atual = ""; continue; }
    atual += c;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
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

/**
 * Os emissores de envio sem política: `sendWhenReady` sem `policy` no terceiro argumento, e `pasteIntoTab` que
 * envia (terceiro argumento que não é `false`) sem política no quinto. Pura.
 */
export function achaEmissores(src: string): { linha: number; texto: string; chamada: string }[] {
  const hits: { linha: number; texto: string; chamada: string }[] = [];
  for (const m of src.matchAll(EMISSOR)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = separaArgumentos(argumentos(src, open));
    const semPolitica = m[1] === "sendWhenReady"
      ? !/\bpolicy\b/.test(args[2] ?? "")
      : (args[2] ?? "") !== "false" && !(args[4] ?? "").trim();
    if (!semPolitica) continue;
    const linha = src.slice(0, m.index ?? 0).split("\n").length;
    hits.push({ linha, texto: src.split("\n")[linha - 1].trim(), chamada: m[1] });
  }
  return hits;
}

/** O caminho com `/`, sempre, para casar com a lista (no Windows o `sep` é `\`). Pura. */
export function paraCaminhoPosix(relativo: string, separador: string): string {
  return relativo.split(separador).join("/");
}

/** Os arquivos de app (não de teste) sob `dir`, com o caminho relativo a `raiz` em `/`. */
function fontes(dir: string, raiz: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome !== "tests" && nome !== "node_modules") out.push(...fontes(caminho, raiz));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(nome) || /\.test\./.test(nome)) continue;
    out.push(paraCaminhoPosix(caminho.slice(raiz.length), sep));
  }
  return out;
}

/** O Enter literal que pode existir fora de `safeWrite.ts`, com o motivo. `ocorrencias` é a contagem exata. */
const PERMITIDOS_ENTER: { arquivo: string; linha: string; ocorrencias: number; motivo: string }[] = [
  {
    arquivo: "features/terminal/terminalRegistry.ts",
    linha: 'term.input("\\r");',
    ocorrencias: 1,
    motivo: "a única primitiva do Enter do registro. Ela confere a política antes de cada Enter; sem política é ação da pessoa.",
  },
  {
    arquivo: "features/canvas/useTerminalPrompts.ts",
    linha: 'if (needsEnter) window.setTimeout(() => sendKeysToTab(tabId, "\\r"), 200);',
    ocorrencias: 1,
    motivo: "resposta explícita da pessoa a um menu de permissão (painel de Time). Não é envio autônomo.",
  },
];

/**
 * Os envios sem política que a própria pessoa dispara (com clique ou digitação agora). O app não escreve sozinho
 * nesses pontos. Cada entrada conta as ocorrências exatas.
 */
const PERMITIDOS_EMISSOR: { arquivo: string; linha: string; ocorrencias: number; motivo: string }[] = [
  { arquivo: "features/chat/chatActions.ts", linha: "if (input.prompt.trim()) sendWhenReady(tabId, input.prompt.trim());", ocorrencias: 1, motivo: "mensagem que a pessoa digita no composer do chat" },
  { arquivo: "features/chat/chatActions.ts", linha: "if (pasteIntoTab(tabId, clean, true)) return true;", ocorrencias: 1, motivo: "mensagem que a pessoa envia a uma conversa (cola e envia)" },
  { arquivo: "features/chat/chatActions.ts", linha: "sendWhenReady(tabId, clean);", ocorrencias: 1, motivo: "fallback da mesma mensagem da pessoa, quando a cola direta não cabe" },
  { arquivo: "features/chat/shellTerminal.ts", linha: "sendWhenReady(tabId, commandText);", ocorrencias: 1, motivo: "comando que a pessoa roda num shell (botão Rodar)" },
  { arquivo: "features/chat/shellTerminal.ts", linha: "if (!runInTerminal(tabId, command)) sendWhenReady(tabId, command);", ocorrencias: 1, motivo: "comando que a pessoa roda num shell, quando o Rodar direto não tem terminal" },
  { arquivo: "features/chat/team/teamStore.ts", linha: "sendWhenReady(ref, text);", ocorrencias: 1, motivo: "mensagem que a pessoa manda a um integrante do time (painel Time)" },
  { arquivo: "features/browser/BrowserTab.tsx", linha: "if (!pasteIntoTab(agent.id, text, true)) {", ocorrencias: 1, motivo: "elemento marcado no navegador que a pessoa envia ao agente" },
  { arquivo: "features/forge/ItemDetailView.tsx", linha: "if (!pasteIntoTab(tabId, itemPrompt(detail, pr), true)) {", ocorrencias: 1, motivo: "item de forge que a pessoa envia ao agente" },
  { arquivo: "features/compare/start.ts", linha: "sendWhenReady(tabId, promptFor(entry.agentId, request, entry, attachments.length > 0), {", ocorrencias: 1, motivo: "comparação que a pessoa inicia (um pedido por agente)" },
  { arquivo: "features/graphify/send.ts", linha: "return pasteIntoTab(tabId, line, true);", ocorrencias: 1, motivo: "comando de grafo que a pessoa escolhe e roda" },
];

/** Os Enters e os emissores de fora da guarda que não estão nas listas permitidas. */
export function naoPermitidos(): string[] {
  const SRC = fileURLToPath(new URL("../../../", import.meta.url));
  const achados: string[] = [];
  const usados = new Map<string, number>();
  for (const arquivo of fontes(SRC, SRC)) {
    // A guarda é o dono dos envios autônomos: não é conferida. O registro tem o Enter literal (conferido abaixo), mas
    // não é emissor: ele é a primitiva que os chamadores usam.
    if (arquivo === "features/terminal/safeWrite.ts") continue;
    const src = readFileSync(join(SRC, ...arquivo.split("/")), "utf8");
    for (const hit of achaEnters(src)) {
      const permitido = PERMITIDOS_ENTER.find((p) => p.arquivo === arquivo && p.linha === hit.texto);
      if (!permitido) {
        achados.push(`${arquivo}:${hit.linha}  ${hit.texto}`);
        continue;
      }
      usados.set(`E|${arquivo}|${hit.texto}`, (usados.get(`E|${arquivo}|${hit.texto}`) ?? 0) + 1);
    }
    if (arquivo === "features/terminal/terminalRegistry.ts") continue;
    for (const hit of achaEmissores(src)) {
      const permitido = PERMITIDOS_EMISSOR.find((p) => p.arquivo === arquivo && p.linha === hit.texto);
      if (!permitido) {
        achados.push(`${arquivo}:${hit.linha}  emissor sem política: ${hit.texto}`);
        continue;
      }
      usados.set(`M|${arquivo}|${hit.texto}`, (usados.get(`M|${arquivo}|${hit.texto}`) ?? 0) + 1);
    }
  }
  for (const p of PERMITIDOS_ENTER) {
    const n = usados.get(`E|${p.arquivo}|${p.linha}`) ?? 0;
    if (n !== p.ocorrencias) achados.push(`lista permitida (Enter): ${p.arquivo} "${p.linha}" casa ${n} vez(es), esperado ${p.ocorrencias}`);
  }
  for (const p of PERMITIDOS_EMISSOR) {
    const n = usados.get(`M|${p.arquivo}|${p.linha}`) ?? 0;
    if (n !== p.ocorrencias) achados.push(`lista permitida (emissor): ${p.arquivo} "${p.linha}" casa ${n} vez(es), esperado ${p.ocorrencias}`);
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

describe("achaEmissores (I4): envio sem política aparece no lint", () => {
  it("sendWhenReady sem política é emissor; com política não", () => {
    expect(achaEmissores("sendWhenReady(id, text);")).toHaveLength(1);
    expect(achaEmissores("sendWhenReady(id, text, timed(a, b));")).toHaveLength(1);
    expect(achaEmissores("sendWhenReady(id, text, { policy: p });")).toHaveLength(0);
  });

  it("pasteIntoTab que envia sem política é emissor; o que não envia ou tem política não é", () => {
    expect(achaEmissores("pasteIntoTab(id, text, true);")).toHaveLength(1);
    expect(achaEmissores("pasteIntoTab(id, text, submit);")).toHaveLength(1);
    expect(achaEmissores("pasteIntoTab(id, text, false);")).toHaveLength(0);
    expect(achaEmissores("pasteIntoTab(id, text, submit, undefined, policy);")).toHaveLength(0);
  });
});

describe("paraCaminhoPosix (I5): o lint roda no Windows", () => {
  it("troca o separador do sistema por / para casar com a lista", () => {
    expect(paraCaminhoPosix("features\\terminal\\safeWrite.ts", "\\")).toBe("features/terminal/safeWrite.ts");
    expect(paraCaminhoPosix("features/terminal/safeWrite.ts", "/")).toBe("features/terminal/safeWrite.ts");
  });
});

describe("Enter e emissor fora da guarda de escrita", () => {
  it("nenhum arquivo de app manda Enter nem envia sem política fora das listas permitidas", () => {
    expect(naoPermitidos()).toEqual([]);
  });
});
