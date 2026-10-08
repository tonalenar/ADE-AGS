import { readFileSync, statSync } from "node:fs";
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

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  if (node.importClause?.isTypeOnly) return true;
  if (!node.importClause) return false;
  if (node.importClause.name) return false;
  const bindings = node.importClause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.length > 0 && node.exportClause.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/** Especificadores de import/export estáticos. Não segue `import()`. */
function staticSpecifiers(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyExport(node)) specs.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const bare = spec.split("?")[0]!;
  if (!bare.startsWith(".") && !bare.startsWith("@/")) return null;
  const base = bare.startsWith("@/")
    ? path.join(SRC, bare.slice(2))
    : path.resolve(path.dirname(fromFile), bare);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* próximo candidato */
    }
  }
  return null;
}

interface Hit {
  from: string;
  spec: string;
  pkg: (typeof FORBIDDEN)[number];
}

function staticReach(roots: string[]): { hits: Hit[]; files: string[] } {
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of staticSpecifiers(file, source)) {
      const pkg = forbiddenPackage(spec);
      if (pkg) hits.push({ from: path.relative(ROOT, file), spec, pkg });
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
    const xterm = staticReach([TERMINAL]);
    const xyflow = staticReach([CANVAS_VIEW]);
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
    const themeAt = terminal.indexOf("theme: TERMINAL_THEMES");
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
