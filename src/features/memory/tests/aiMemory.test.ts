import { describe, expect, it } from "vitest";
import { formatCreatedAt, groupPendingHandoffs, parseSnippet, type AiMemoryHandoff } from "../aiMemory";

describe("parseSnippet (snippet do ai-memory search --json)", () => {
  it("destaca o <mark> do fixture real e mantém o resto como texto", () => {
    // Fixture real: search-populated.stdout do adendo (ai-memory 3.3.0).
    const segs = parseSnippet("A <mark>fixtureunique</mark> local test page.");
    expect(segs).toEqual([
      { text: "A ", highlight: false },
      { text: "fixtureunique", highlight: true },
      { text: " local test page.", highlight: false },
    ]);
  });

  it("snippet sem <mark> vira um único segmento sem destaque", () => {
    expect(parseSnippet("A fixtureunique local test page.")).toEqual([
      { text: "A fixtureunique local test page.", highlight: false },
    ]);
  });

  it("descarta outras tags e mantém o texto de dentro", () => {
    const segs = parseSnippet("<b>negrito</b> e <script>x()</script>");
    expect(segs).toEqual([{ text: "negrito e x()", highlight: false }]);
    expect(JSON.stringify(segs)).not.toContain("<");
  });

  it("funde marks vizinhos e aceita mark no início e no fim", () => {
    expect(parseSnippet("<mark>a</mark><mark>b</mark>")).toEqual([{ text: "ab", highlight: true }]);
    expect(parseSnippet("<mark>início</mark> meio <mark>fim</mark>")).toEqual([
      { text: "início", highlight: true },
      { text: " meio ", highlight: false },
      { text: "fim", highlight: true },
    ]);
  });

  it("mark não fechado segue destacado até o fim, sem quebrar", () => {
    expect(parseSnippet("x <mark>y")).toEqual([
      { text: "x ", highlight: false },
      { text: "y", highlight: true },
    ]);
  });

  it("mantém < solto que não é tag", () => {
    expect(parseSnippet("a < b e 2 > 1")).toEqual([{ text: "a < b e 2 > 1", highlight: false }]);
  });

  it("snippet vazio não gera segmentos", () => {
    expect(parseSnippet("")).toEqual([]);
  });
});

describe("formatCreatedAt (created_at_ms do handoff)", () => {
  // created_at_ms do fixture handoffs-populated.stdout: 2026-10-30T18:28:56.570Z.
  const ms = 1793384936570;

  it("formata em UTC com o fuso informado, sem depender do fuso da máquina", () => {
    expect(formatCreatedAt(ms, "pt-BR", "UTC")).toBe("30/10/2026, 18:28");
    expect(formatCreatedAt(ms, "pt-BR", "America/Sao_Paulo")).toBe("30/10/2026, 15:28");
  });

  it("devolve vazio para um instante inválido, em vez de estourar", () => {
    expect(formatCreatedAt(Number.NaN, "pt-BR", "UTC")).toBe("");
  });
});

describe("groupPendingHandoffs (handoffs --json do ai-memory)", () => {
  const h = (id: string, toAgent: string | null, createdAtMs: number): AiMemoryHandoff => ({
    id,
    from_agent: "other",
    to_agent: toAgent,
    cwd: "/workspace",
    created_at_ms: createdAtMs,
  });

  it("agrupa por to_agent: nomeados em ordem, sem destinatário por último, mais antigos primeiro", () => {
    const list = [h("c", "codex", 300), h("n", null, 100), h("a", "claude", 200), h("b", "codex", 150)];
    const groups = groupPendingHandoffs(list);
    expect(groups.map((g) => g.toAgent)).toEqual(["claude", "codex", null]);
    expect(groups[1].handoffs.map((x) => x.id)).toEqual(["b", "c"]);
    expect(groups[2].handoffs.map((x) => x.id)).toEqual(["n"]);
  });

  it("não altera a lista de entrada", () => {
    const list = [h("c", "codex", 300), h("b", "codex", 150)];
    groupPendingHandoffs(list);
    expect(list.map((x) => x.id)).toEqual(["c", "b"]);
  });

  it("to_agent vazio conta como sem destinatário", () => {
    const groups = groupPendingHandoffs([h("x", "", 1)]);
    expect(groups.map((g) => g.toAgent)).toEqual([null]);
  });

  it("lista vazia não gera grupos", () => {
    expect(groupPendingHandoffs([])).toEqual([]);
  });

  it("o fixture real (to_agent null) vira um grupo sem destinatário", () => {
    // Fixture real: handoffs-populated.stdout do adendo (ai-memory 3.3.0).
    const groups = groupPendingHandoffs([
      {
        id: "01a18e12-747a-7eb0-8f08-5c8ead5e3d24",
        from_agent: "other",
        to_agent: null,
        cwd: "/private/tmp/ade-ai-memory-backend.CgesI3/adendo/workspace",
        created_at_ms: 1793384936570,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].toAgent).toBeNull();
    expect(groups[0].handoffs).toHaveLength(1);
  });
});
