import { describe, expect, it } from "vitest";

import { searchHitsFromSources } from "../searchHits";

describe("searchHitsFromSources", () => {
  it("acha no patch da listagem sem precisar do conteúdo inteiro", () => {
    const hits = searchHitsFromSources("quota", [
      { path: "src/a.ts", patch: "@@ -1 +1 @@\n+const quota = 1;\n" },
      { path: "src/b.ts", patch: null },
    ], {});
    expect(hits.map((hit) => hit.path)).toEqual(["src/a.ts"]);
    expect(hits[0]?.excerpt).toContain("quota");
  });

  it("prefere o arquivo já carregado quando há conteúdo", () => {
    const hits = searchHitsFromSources("hello", [
      { path: "src/a.ts", patch: "+hello from patch" },
    ], { "src/a.ts": { content: "line1\nhello world\n" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.excerpt).toContain("hello world");
  });
});
