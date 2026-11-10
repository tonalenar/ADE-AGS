import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Onda 4: o entry da home, `EditorArea` e `TerminalPanel` não podem alcançar
 * `@xterm/xterm` nem `@xyflow/react` por import estático. `import()` e `import type`
 * não contam — o primeiro é o chunk lazy, o segundo o TypeScript apaga.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(ROOT, "src");

const FORBIDDEN = ["@xterm/xterm", "@xyflow/react"] as const;

const ENTRY = path.join(SRC, "main.tsx");
const EDITOR_AREA = path.join(SRC, "features/tabs/EditorArea.tsx");
const TERMINAL_PANEL = path.join(SRC, "features/terminal/TerminalPanel.tsx");
const TERMINAL = path.join(SRC, "features/terminal/Terminal.tsx");
const CANVAS_VIEW = path.join(SRC, "features/canvas/CanvasView.tsx");

function forbiddenPackage(spec: string): (typeof FORBIDDEN)[number] | null {
  const bare = spec.split("?")[0]!;
  return FORBIDDEN.find((pkg) => bare === pkg || bare.startsWith(`${pkg}/`)) ?? null;
}

/**
 * Especificadores de import/export estáticos. Não segue `import()`.
 * O scanner não monta AST: `createSourceFile` no grafo do entry passa de 5 s
 * quando a suíte inteira disputa a máquina.
 */
function staticSpecifiers(fileName: string, source: string): string[] {
  const variant = fileName.endsWith(".tsx") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const specs: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i += 1;
      continue;
    }
    if (c === 47) {
      const skipped = skipSlash(source, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
    }
    if (c === 39 || c === 34) {
      i = skipString(source, i);
      continue;
    }
    if (c === 96) {
      i = skipTemplate(source, i);
      continue;
    }
    if (isWordAt(source, i, "import")) {
      i = consumeClause(source, i, "import", variant, specs);
      continue;
    }
    if (isWordAt(source, i, "export")) {
      i = consumeClause(source, i, "export", variant, specs);
      continue;
    }
    if (isIdentChar(c)) {
      i += 1;
      while (i < n && isIdentChar(source.charCodeAt(i))) i += 1;
      continue;
    }
    i += 1;
  }
  return specs;
}

function isIdentChar(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

function isWordAt(source: string, i: number, word: string): boolean {
  if (!source.startsWith(word, i)) return false;
  if (i > 0 && isIdentChar(source.charCodeAt(i - 1))) return false;
  return !isIdentChar(source.charCodeAt(i + word.length));
}

function skipString(source: string, i: number): number {
  const quote = source.charCodeAt(i);
  const n = source.length;
  i += 1;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** Pula um template, inclusive o código de `${...}`, para não ver `import` que é só texto. */
function skipTemplate(source: string, i: number): number {
  const n = source.length;
  i += 1;
  let depth = 0;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === 92 && depth === 0) {
      i += 2;
      continue;
    }
    if (c === 96 && depth === 0) return i + 1;
    if (c === 36 && source.charCodeAt(i + 1) === 123) {
      depth += 1;
      i += 2;
      continue;
    }
    if (depth > 0 && c === 123) {
      depth += 1;
      i += 1;
      continue;
    }
    if (depth > 0 && c === 125) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth > 0 && (c === 39 || c === 34)) {
      i = skipString(source, i);
      continue;
    }
    if (depth > 0 && c === 96) {
      i = skipTemplate(source, i);
      continue;
    }
    if (depth > 0 && c === 47) {
      const skipped = skipSlash(source, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

/**
 * Lê só a declaração. `export function` e o resto do arquivo continuam no laço de caracteres:
 * o scanner do TypeScript fica restrito à cláusula, que é curta.
 */
function consumeClause(
  source: string,
  i: number,
  kind: "import" | "export",
  variant: ts.LanguageVariant,
  specs: string[],
): number {
  const after = i + kind.length;
  if (kind === "import" && /^\s*[.(]/.test(source.slice(after, after + 8))) return after;
  if (kind === "export" && !/^\s*(type\s*)?(\*|\{)/.test(source.slice(after, after + 32))) return after;
  const end = statementEnd(source, i);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, source.slice(i, end));
  const token = scanner.scan();
  if (kind === "import" && token === ts.SyntaxKind.ImportKeyword) readStaticImport(scanner, specs);
  else if (kind === "export" && token === ts.SyntaxKind.ExportKeyword) readStaticExport(scanner, specs);
  return end;
}

function skipSlash(source: string, i: number): number {
  const next = source.charCodeAt(i + 1);
  if (next === 47) {
    const nl = source.indexOf("\n", i + 2);
    return nl < 0 ? source.length : nl + 1;
  }
  if (next === 42) {
    const end = source.indexOf("*/", i + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (!slashIsRegex(source, i)) return i;
  const n = source.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = source.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 10 || c === 13) return j;
    if (c === 91) inClass = true;
    else if (c === 93) inClass = false;
    else if (c === 47 && !inClass) {
      j += 1;
      while (j < n && ((source.charCodeAt(j) >= 65 && source.charCodeAt(j) <= 90) || (source.charCodeAt(j) >= 97 && source.charCodeAt(j) <= 122))) j += 1;
      return j;
    }
    j += 1;
  }
  return j;
}

/** `/` depois de `)`, `]` ou identificador comum é divisão; o resto pode ser regex. */
function slashIsRegex(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0) {
    const c = source.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      j -= 1;
      continue;
    }
    if (c === 41 || c === 93 || c === 125) return false;
    if (isIdentChar(c)) {
      let k = j;
      while (k >= 0 && isIdentChar(source.charCodeAt(k))) k -= 1;
      const word = source.slice(k + 1, j + 1);
      return word === "return" || word === "case" || word === "throw" || word === "else" || word === "typeof" || word === "void" || word === "delete" || word === "in" || word === "of" || word === "yield" || word === "await";
    }
    return true;
  }
  return true;
}

function statementEnd(source: string, i: number): number {
  const n = source.length;
  let j = i;
  while (j < n) {
    const c = source.charCodeAt(j);
    if (c === 59) return j + 1;
    if (c === 39 || c === 34) {
      j = skipString(source, j);
      continue;
    }
    if (c === 96) {
      j = skipTemplate(source, j);
      continue;
    }
    if (c === 47) {
      const skipped = skipSlash(source, j);
      if (skipped !== j) {
        j = skipped;
        continue;
      }
    }
    j += 1;
  }
  return j;
}

function readStaticImport(scanner: ts.Scanner, specs: string[]): void {
  const token = scanner.scan();
  if (token === ts.SyntaxKind.OpenParenToken || token === ts.SyntaxKind.DotToken) return;
  if (token === ts.SyntaxKind.TypeKeyword) return;
  if (token === ts.SyntaxKind.StringLiteral) {
    specs.push(scanner.getTokenValue());
    return;
  }
  let hasValue = false;
  if (token === ts.SyntaxKind.AsteriskToken) {
    hasValue = true;
  } else if (token === ts.SyntaxKind.OpenBraceToken) {
    hasValue = readNamed(scanner);
  } else {
    hasValue = true;
    const next = scanner.scan();
    if (next === ts.SyntaxKind.CommaToken && scanner.scan() === ts.SyntaxKind.OpenBraceToken) {
      hasValue = readNamed(scanner) || hasValue;
    } else {
      const spec = specifierAt(scanner, next);
      if (hasValue && spec) specs.push(spec);
      return;
    }
  }
  const spec = specifierAt(scanner, scanner.scan());
  if (hasValue && spec) specs.push(spec);
}

function readStaticExport(scanner: ts.Scanner, specs: string[]): void {
  const token = scanner.scan();
  if (token === ts.SyntaxKind.TypeKeyword) return;
  if (token === ts.SyntaxKind.AsteriskToken) {
    const spec = specifierAt(scanner, scanner.scan());
    if (spec) specs.push(spec);
    return;
  }
  if (token === ts.SyntaxKind.OpenBraceToken) {
    const hasValue = readNamed(scanner);
    const spec = specifierAt(scanner, scanner.scan());
    if (hasValue && spec) specs.push(spec);
  }
}

/** `true` quando algum nome do `{ ... }` é valor, não `type`. */
function readNamed(scanner: ts.Scanner): boolean {
  let hasValue = false;
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.CloseBraceToken && token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.CommaToken) {
      token = scanner.scan();
      continue;
    }
    if (token === ts.SyntaxKind.TypeKeyword) {
      const next = scanner.scan();
      if (next === ts.SyntaxKind.AsKeyword || next === ts.SyntaxKind.CommaToken || next === ts.SyntaxKind.CloseBraceToken) {
        hasValue = true;
        token = next === ts.SyntaxKind.AsKeyword ? afterAlias(scanner) : next;
        continue;
      }
      token = next;
      if (token === ts.SyntaxKind.Identifier) {
        token = scanner.scan();
        if (token === ts.SyntaxKind.AsKeyword) token = afterAlias(scanner);
      }
      continue;
    }
    hasValue = true;
    if (token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.DefaultKeyword) {
      token = scanner.scan();
      if (token === ts.SyntaxKind.AsKeyword) token = afterAlias(scanner);
      continue;
    }
    token = scanner.scan();
  }
  return hasValue;
}

function afterAlias(scanner: ts.Scanner): ts.SyntaxKind {
  scanner.scan();
  return scanner.scan();
}

/** O especificador depois de `from`, inclusive `export * as Nome from "..."`. */
function specifierAt(scanner: ts.Scanner, token: ts.SyntaxKind): string | null {
  if (token === ts.SyntaxKind.AsKeyword) {
    scanner.scan();
    token = scanner.scan();
  }
  // No scanner do TypeScript, `from` é `FromKeyword`, não um identificador.
  if (token === ts.SyntaxKind.FromKeyword || (token === ts.SyntaxKind.Identifier && scanner.getTokenValue() === "from")) {
    if (scanner.scan() === ts.SyntaxKind.StringLiteral) return scanner.getTokenValue();
  }
  return null;
}

const specCache = new Map<string, string[]>();
const resolveCache = new Map<string, string | null>();
const dirNames = new Map<string, Set<string>>();

function namesIn(dir: string): Set<string> {
  const hit = dirNames.get(dir);
  if (hit) return hit;
  const names = new Set<string>();
  try {
    for (const name of readdirSync(dir)) names.add(name);
  } catch {
    /* a pasta não existe */
  }
  dirNames.set(dir, names);
  return names;
}

function cachedSpecifiers(file: string): string[] {
  const hit = specCache.get(file);
  if (hit) return hit;
  const specs = staticSpecifiers(file, readFileSync(file, "utf8"));
  specCache.set(file, specs);
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const key = `${fromFile}\0${spec}`;
  if (resolveCache.has(key)) return resolveCache.get(key) ?? null;
  const bare = spec.split("?")[0]!;
  let found: string | null = null;
  if (bare.startsWith(".") || bare.startsWith("@/")) {
    const base = bare.startsWith("@/")
      ? path.join(SRC, bare.slice(2))
      : path.resolve(path.dirname(fromFile), bare);
    const dir = path.dirname(base);
    const name = path.basename(base);
    const names = namesIn(dir);
    if (names.has(name)) {
      try {
        if (statSync(base).isFile()) found = base;
      } catch {
        /* é pasta; o índice vem abaixo */
      }
    }
    if (!found) {
      const ext = [".ts", ".tsx", ".js", ".mjs"].find((suffix) => names.has(name + suffix));
      if (ext) found = base + ext;
    }
    if (!found && names.has(name)) {
      const inner = namesIn(base);
      if (inner.has("index.ts")) found = path.join(base, "index.ts");
      else if (inner.has("index.tsx")) found = path.join(base, "index.tsx");
    }
  }
  resolveCache.set(key, found);
  return found;
}

interface Hit {
  from: string;
  spec: string;
  pkg: (typeof FORBIDDEN)[number];
}

function staticReach(roots: string[], stopAtFirstHit = false): { hits: Hit[]; files: string[] } {
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of cachedSpecifiers(file)) {
      const pkg = forbiddenPackage(spec);
      if (pkg) {
        hits.push({ from: path.relative(ROOT, file), spec, pkg });
        if (stopAtFirstHit) return { hits, files: [...seen] };
      }
      const next = resolveLocal(file, spec);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return { hits, files: [...seen] };
}

describe("grafo estático do entry (onda 4)", () => {
  it("ignora import type e import(), e vê import de valor", () => {
    const source = `
      import type { Terminal } from "@xterm/xterm";
      import { type Node, type NodeProps } from "@xyflow/react";
      export type { Edge } from "@xyflow/react";
      const load = () => import("@xterm/xterm");
      import { FitAddon } from "@xterm/addon-fit";
      import "@xyflow/react/dist/style.css";
    `;
    expect(staticSpecifiers("probe.tsx", source)).toEqual([
      "@xterm/addon-fit",
      "@xyflow/react/dist/style.css",
    ]);
    expect(forbiddenPackage("@xyflow/react/dist/style.css")).toBe("@xyflow/react");
    expect(forbiddenPackage("@xterm/addon-fit")).toBeNull();
  });

  it("o controle positivo acha xterm em Terminal.tsx e xyflow em CanvasView.tsx", () => {
    const xterm = staticReach([TERMINAL], true);
    const xyflow = staticReach([CANVAS_VIEW], true);
    expect(xterm.hits.map((hit) => hit.pkg)).toContain("@xterm/xterm");
    expect(xyflow.hits.map((hit) => hit.pkg)).toContain("@xyflow/react");
  });

  it.each([
    ["entry", ENTRY],
    ["EditorArea", EDITOR_AREA],
    ["TerminalPanel", TERMINAL_PANEL],
  ])("%s não importa @xterm/xterm nem @xyflow/react no grafo estático", (_label, root) => {
    const { hits } = staticReach([root]);
    expect(hits).toEqual([]);
  });

  it("o entry passa por terminalRegistry (import type de xterm) sem puxar o pacote", () => {
    const { files, hits } = staticReach([ENTRY]);
    expect(files.some((file) => file.endsWith(`${path.sep}terminalRegistry.ts`))).toBe(true);
    expect(files.some((file) => file.endsWith(`${path.sep}Terminal.tsx`))).toBe(false);
    expect(files.some((file) => file.endsWith(`${path.sep}CanvasView.tsx`))).toBe(false);
    expect(hits).toEqual([]);
  });

  it("tema no construtor, fitOnce espera fontsReady antes do pty, e a home não espera a fonte", () => {
    const terminal = readFileSync(TERMINAL, "utf8");
    const ctorAt = terminal.indexOf("new XTerm(");
    // O tema vem de `terminalThemeFor` (tema do app + tema personalizado), que parte de TERMINAL_THEMES.
    const themeAt = terminal.indexOf("theme: terminalThemeFor(");
    const fitAt = terminal.indexOf("await fitOnce()");
    const ptyAt = terminal.indexOf("ptyCreate(");
    expect(ctorAt).toBeGreaterThan(0);
    expect(themeAt).toBeGreaterThan(ctorAt);
    expect(fitAt).toBeGreaterThan(themeAt);
    expect(ptyAt).toBeGreaterThan(fitAt);

    const fit = readFileSync(path.join(SRC, "features/terminal/fit.ts"), "utf8");
    const fitOnceAt = fit.indexOf("const fitOnce = async () => {");
    const awaitFonts = fit.indexOf("await fonts", fitOnceAt);
    const measure = fit.indexOf("fit();", awaitFonts);
    expect(fit).toContain('import { fontsReady } from "./fontsReady"');
    expect(fitOnceAt).toBeGreaterThan(0);
    expect(awaitFonts).toBeGreaterThan(fitOnceAt);
    expect(measure).toBeGreaterThan(awaitFonts);

    const main = readFileSync(ENTRY, "utf8");
    const renderAt = main.indexOf("ReactDOM.createRoot");
    expect(main).toContain("fontsReady");
    expect(main).not.toContain("document.fonts.load(");
    expect(main).not.toContain("await fontsReady");
    expect(main).not.toMatch(/fontsReady\s*\)\s*\.then\(/);
    expect(renderAt).toBeGreaterThan(main.indexOf("whenHomeCanPaint"));

    const boot = readFileSync(path.join(SRC, "app/bootGate.ts"), "utf8");
    expect(boot).toContain("void deps.fontsReady");
    expect(boot).toContain("Promise.all([deps.loadAgentRegistry(), deps.applyRendering()])");
    expect(boot).not.toMatch(/Promise\.all\(\[[^\]]*fontsReady/);
  });
});
