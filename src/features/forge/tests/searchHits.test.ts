import { describe, expect, it } from "vitest";

import { searchHitsFromSources } from "../searchHits";

function hitsOf(
  query: string,
  files: { path: string; patch: string | null }[],
  contents: Record<string, { content: string | null }> = {},
) {
  const result = searchHitsFromSources(query, files, contents);
  return Array.isArray(result) ? { hits: result, partial: undefined } : result;
}

describe("searchHitsFromSources", () => {
  it("mapeia o hit do patch para a linha nova do arquivo, não a linha do diff", () => {
    const { hits, partial } = hitsOf("quota", [
      { path: "src/a.ts", patch: "@@ -1 +1 @@\n+const quota = 1;\n" },
      { path: "src/b.ts", patch: null },
    ]);
    expect(hits.map((hit) => hit.path)).toEqual(["src/a.ts"]);
    expect(hits[0]?.line).toBe(1);
    expect(hits[0]?.excerpt).toContain("quota");
    expect(partial).toBe(true);
  });

  it("conta só linhas + e de contexto depois do cabeçalho @@", () => {
    const patch = [
      "@@ -10,3 +20,4 @@",
      " keep",
      "-old",
      "+const quota = 1;",
      " more",
      "",
    ].join("\n");
    const { hits } = hitsOf("quota", [{ path: "src/a.ts", patch }]);
    expect(hits[0]?.line).toBe(21);
  });

  it("prefere o arquivo já carregado quando há conteúdo", () => {
    const { hits, partial } = hitsOf("hello", [
      { path: "src/a.ts", patch: "+hello from patch" },
    ], { "src/a.ts": { content: "line1\nhello world\n" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.excerpt).toContain("hello world");
    expect(partial).toBe(false);
  });

  it("não corta um + que pertence ao conteúdo do arquivo", () => {
    const { hits } = hitsOf("plus", [
      { path: "src/a.ts", patch: null },
    ], { "src/a.ts": { content: "+plus one\n" } });
    expect(hits[0]?.excerpt).toBe("+plus one");
  });

  it("limita o excerto longo", () => {
    const line = `const quota = "${"x".repeat(300)}";`;
    const { hits } = hitsOf("quota", [
      { path: "src/a.ts", patch: `@@ -1 +1 @@\n+${line}\n` },
    ]);
    expect(hits[0]?.excerpt.length).toBeLessThanOrEqual(201);
  });
});
