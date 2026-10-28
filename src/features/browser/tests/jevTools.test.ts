import { describe, expect, it, vi } from "vitest";

import type { ParsedPage, PilotDeps } from "../jevPilot";
import {
  checkInputs,
  formatRun,
  parseReadSpec,
  readRowsCode,
  recordingDeps,
  resolveMatch,
  runTool,
  toolFrom,
  type JevTool,
  type ToolRunDeps,
} from "../jevTools";

/** Um snapshot no formato que `parseSnapshot` lê. */
function snap(url: string, lines: string[]): string {
  return [`page: "Loja" ${url}`, ...lines].join("\n");
}

const HOME = snap("https://loja.test/", [
  '- button "Aceitar cookies" [ref=e1]',
  '- searchbox "Buscar produtos" [ref=e2]',
  '- link "Ofertas" [ref=e3]',
]);
const RESULTS = snap("https://loja.test/busca?q=x", [
  '- link "Ver detalhes" [ref=e7]',
  '- button "Adicionar ao carrinho" [ref=e8]',
]);

function fakeDeps(pages: string[]): PilotDeps {
  let i = 0;
  return {
    snapshot: vi.fn(async () => pages[Math.min(i++, pages.length - 1)]),
    click: vi.fn(async () => "ok"),
    type: vi.fn(async () => "ok"),
    select: vi.fn(async () => "ok"),
    scroll: vi.fn(async () => "ok"),
    settle: vi.fn(async () => undefined),
    pick: vi.fn(async () => { throw new Error("o Jev não é chamado no teste"); }),
  } as unknown as PilotDeps;
}

describe("gravar", () => {
  it("anota cliques e digitação por papel e nome, com o valor como entrada", async () => {
    const { deps, recording } = recordingDeps(fakeDeps([HOME, RESULTS]), [["busca", "fone bluetooth"]]);
    await deps.snapshot();
    await deps.click("e1");
    await deps.type("e2", "fone bluetooth", true);
    await deps.snapshot();
    await deps.click("e7", true);
    const rec = recording();
    expect(rec.problems).toEqual([]);
    expect(rec.startUrl).toBe("https://loja.test/");
    expect(rec.steps).toEqual([
      { op: "click", match: { role: "button", name: "Aceitar cookies" }, optional: true },
      { op: "type", match: { role: "searchbox", name: "Buscar produtos" }, value: { param: "busca" }, submit: true },
      { op: "click", match: { role: "link", name: "Ver detalhes" } },
    ]);
  });

  it("um toque que muda o site, um texto que não veio de --fill ou um toque por foto não viram ferramenta", async () => {
    const base = fakeDeps([HOME, RESULTS]);
    base.clickAt = vi.fn(async () => "ok");
    const { deps, recording } = recordingDeps(base, []);
    await deps.snapshot();
    await deps.type("e2", "inventado");
    await deps.snapshot();
    await deps.click("e8");
    await deps.clickAt!(10, 10);
    const problems = recording().problems.join(" | ");
    expect(problems).toMatch(/não veio de um --fill/);
    expect(problems).toMatch(/Adicionar ao carrinho.*leitura/);
    expect(problems).toMatch(/toque por foto/);
  });

  it("a ação acontece mesmo quando não vira passo: gravar só observa", async () => {
    const base = fakeDeps([RESULTS]);
    const { deps } = recordingDeps(base, []);
    await deps.snapshot();
    await deps.click("e8");
    expect(base.click).toHaveBeenCalledWith("e8", undefined);
  });

  it("toolFrom só usa como entrada o que algum passo usa, e recusa nome ruim", () => {
    const rec = { startUrl: "https://loja.test/", steps: [{ op: "type" as const, match: { role: "searchbox", name: "Buscar" }, value: { param: "busca" }, submit: true }], problems: [] };
    const made = toolFrom("busca_loja", "buscar", rec, [["busca", "x"], ["sobra", "y"]], parseReadSpec(undefined), new Date("2026-10-26T00:00:00Z"));
    expect("tool" in made && made.tool.inputs).toEqual(["busca"]);
    expect("problems" in toolFrom("Busca Loja", "x", rec, [], parseReadSpec(undefined))).toBe(true);
  });
});

describe("--read", () => {
  it("texto por padrão, texto com limite e linhas de uma lista", () => {
    expect(parseReadSpec(undefined)).toEqual({ kind: "text", maxLines: 60 });
    expect(parseReadSpec("text:20")).toEqual({ kind: "text", maxLines: 20 });
    expect(parseReadSpec("rows:#res li|nome=h3|preco=.price|limit=10")).toEqual({
      kind: "rows", rows: "#res li", fields: { nome: "h3", preco: ".price" }, limit: 10,
    });
    expect(() => parseReadSpec("rows:#res li")).toThrow(/campo=seletor/);
    expect(() => parseReadSpec("json")).toThrow(/não entende/);
  });

  it("o código de página não tem separador de linha cru (dentro de uma regex literal ele a quebra: «missing /»)", () => {
    const code = readRowsCode({ kind: "rows", rows: "li", fields: { a: "b" }, limit: 5 });
    for (const cp of [0x85, 0x2028, 0x2029]) expect(code.includes(String.fromCharCode(cp))).toBe(false);
    expect(() => new Function(`return (${code})`)).not.toThrow();
  });

  it("o código de página leva o seletor como dado (JSON), nunca como código", () => {
    const code = readRowsCode({ kind: "rows", rows: 'li"); alert(1); ("', fields: { a: "b" }, limit: 5 });
    expect(code).toContain(JSON.stringify('li"); alert(1); ("'));
    expect(code.startsWith("((spec) =>")).toBe(true);
  });
});

describe("achar o elemento de novo", () => {
  const page = (lines: string[]): ParsedPage => ({ title: "", url: "https://x.test/", text: [], elements: lines.map((l, i) => {
    const [role, name, href, near] = l.split("|");
    return { ref: `e${i}`, role, name, states: [], filled: null, ...(href ? { href } : {}), ...(near ? { near } : {}) };
  }) });

  it("pelo papel e nome (sem acento e caixa), desempatando por endereço e por vizinho", () => {
    const p = page(["link|Ver detalhes|/a|Fone A", "link|Ver detalhes|/b|Fone B", "button|Buscar"]);
    expect(resolveMatch(p, { role: "button", name: "buscar" })).toEqual({ ref: "e2" });
    expect(resolveMatch(p, { role: "link", name: "Ver detalhes", href: "/b" })).toEqual({ ref: "e1" });
    expect(resolveMatch(p, { role: "link", name: "Ver detalhes", near: "Fone A" })).toEqual({ ref: "e0" });
  });

  it("dois iguais sem nada que distinga é erro; cópias que levam ao mesmo lugar valem a primeira", () => {
    const p = page(["link|Ver detalhes|/a", "link|Ver detalhes|/b"]);
    expect(resolveMatch(p, { role: "link", name: "Ver detalhes" })).toHaveProperty("error");
    const copies = page(["link|Ofertas|/ofertas", "link|Ofertas|/ofertas"]);
    expect(resolveMatch(copies, { role: "link", name: "Ofertas" })).toEqual({ ref: "e0" });
    expect(resolveMatch(copies, { role: "link", name: "Sumiu" })).toHaveProperty("error");
  });
});

describe("reproduzir", () => {
  const tool: JevTool = {
    version: 1, name: "busca_loja", goal: "buscar", startUrl: "https://loja.test/", authority: "read", inputs: ["busca"],
    steps: [
      { op: "click", match: { role: "button", name: "Aceitar cookies" }, optional: true },
      { op: "type", match: { role: "searchbox", name: "Buscar produtos" }, value: { param: "busca" }, submit: true },
    ],
    read: { kind: "text", maxLines: 5 }, createdAt: "2026-10-26T00:00:00Z",
  };

  function runDeps(pages: string[]): ToolRunDeps {
    let i = 0;
    return {
      navigate: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => pages[Math.min(i++, pages.length - 1)]),
      click: vi.fn(async () => "ok"),
      type: vi.fn(async () => "ok"),
      select: vi.fn(async () => "ok"),
      scroll: vi.fn(async () => "ok"),
      evaluate: vi.fn(async () => ({ records: [{ nome: "Fone" }] })),
    };
  }

  it("refaz os passos sem o Jev, digita a entrada e lê o texto", async () => {
    const noCookies = snap("https://loja.test/", ['- searchbox "Buscar produtos" [ref=e9]', "- text: Bem-vindo"]);
    const deps = runDeps([noCookies, noCookies, snap("https://loja.test/busca", ["- text: 3 resultados"])]);
    const result = await runTool(tool, { busca: "fone" }, deps);
    expect(result.ok).toBe(true);
    expect(deps.navigate).toHaveBeenCalledWith("https://loja.test/");
    expect(deps.type).toHaveBeenCalledWith("e9", "fone", true);
    expect(result.done.some((d) => d.startsWith("pulou"))).toBe(true);
    expect(formatRun(tool, result)).toMatch(/ok em .* sem o Jev/);
  });

  it("um passo que não acha o elemento PARA e manda gravar de novo", async () => {
    const deps = runDeps([snap("https://loja.test/", ['- link "Outra coisa" [ref=e1]'])]);
    const result = await runTool(tool, { busca: "fone" }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/passo 2 de 2.*--replace/);
    expect(deps.type).not.toHaveBeenCalled();
  });

  it("entradas que faltam ou sobram são recusadas antes de abrir a página", async () => {
    expect(checkInputs(tool, {})).toMatch(/--input busca/);
    expect(checkInputs(tool, { busca: "x", outra: "y" })).toMatch(/não usa: outra/);
    const deps = runDeps([HOME]);
    const result = await runTool(tool, {}, deps);
    expect(result.ok).toBe(false);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("lê uma lista pelo código de página", async () => {
    const rows: JevTool = { ...tool, inputs: [], steps: [], read: { kind: "rows", rows: "li", fields: { nome: "h3" }, limit: 10 } };
    const result = await runTool(rows, {}, runDeps([HOME]));
    expect(result.data).toEqual([{ nome: "Fone" }]);
  });
});
