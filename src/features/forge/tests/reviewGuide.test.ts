import { describe, expect, it } from "vitest";

import {
  askPrompt, askWorkdir, goTo, hostFileUrl, inRange, initStepper, isEditableTarget, nextStop, parsePatch,
  parseVisited, prevStop, stepperKey, visitedKey,
} from "../reviewGuide";
import type { ForgeItem, ReviewGuide } from "../types";

const guide: ReviewGuide = {
  summary: "Adiciona cache de cota.",
  risk: "medium",
  stops: [
    { id: "types", title: "Os tipos", files: [{ path: "src/types.ts" }], why: "Base.", lookClosely: ["nulos"] },
    { id: "cache", title: "O cache", files: [{ path: "src/cache.rs", lines: { start: 10, end: 20 } }], why: "Núcleo.", lookClosely: ["TTL"], excerpt: "+let ttl = 5;", questions: ["E a invalidação?"] },
    { id: "tests", title: "Os testes", files: [{ path: "src/cache_test.rs" }], why: "Cobertura.", lookClosely: ["casos de borda"] },
  ],
};

const item: ForgeItem = {
  number: 42, title: "Cache de cota", state: "open", draft: false, author: "ana",
  webUrl: "https://github.com/o/r/pull/42", createdAt: null, updatedAt: null, comments: null, labels: [],
  sourceBranch: "feat/cota", targetBranch: "dev",
};

describe("passo a passo do guia", () => {
  it("começa na primeira parada e já a conta como vista", () => {
    expect(initStepper(guide, [])).toEqual({ current: 0, visited: ["types"] });
  });

  it("retoma na primeira ainda não vista e descarta ids que sumiram", () => {
    expect(initStepper(guide, ["types", "velha"])).toEqual({ current: 1, visited: ["types", "cache"] });
    // Todas vistas: volta ao começo.
    expect(initStepper(guide, ["types", "cache", "tests"]).current).toBe(0);
  });

  it("próxima e anterior param nas pontas e marcam visitadas", () => {
    let s = initStepper(guide, []);
    s = prevStop(s, guide);
    expect(s.current).toBe(0);
    s = nextStop(nextStop(nextStop(s, guide), guide), guide);
    expect(s.current).toBe(2);
    expect(s.visited).toEqual(["types", "cache", "tests"]);
    s = goTo(s, guide, 1);
    expect(s.current).toBe(1);
    expect(s.visited).toHaveLength(3);
  });

  it("teclas: setas e j/k sem modificador", () => {
    expect(stepperKey({ key: "ArrowRight" })).toBe("next");
    expect(stepperKey({ key: "j" })).toBe("next");
    expect(stepperKey({ key: "ArrowLeft" })).toBe("prev");
    expect(stepperKey({ key: "k" })).toBe("prev");
    expect(stepperKey({ key: "ArrowRight", ctrlKey: true })).toBeNull();
    expect(stepperKey({ key: "Enter" })).toBeNull();
  });

  it("não rouba a seta de um campo de texto", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("as visitadas são por PR e commit, e lixo vira lista vazia", () => {
    expect(visitedKey("o/r", 42, "abc")).toBe("cc-review-guide-visited:o/r#42@abc");
    expect(parseVisited('["a", 3, "b"]')).toEqual(["a", "b"]);
    expect(parseVisited("{quebrado")).toEqual([]);
    expect(parseVisited(null)).toEqual([]);
  });
});

describe("diff de um arquivo", () => {
  const patch = "@@ -8,4 +8,5 @@ fn x()\n ctx\n-velha\n+nova\n+outra\n ctx2\n\\ No newline at end of file\n";

  it("numera as linhas da versão nova e da velha", () => {
    const lines = parsePatch(patch);
    expect(lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "add", "ctx", "meta"]);
    expect(lines.map((l) => l.newLine)).toEqual([null, 8, null, 9, 10, 11, null]);
    expect(lines[2].oldLine).toBe(9);
  });

  it("destaca só as linhas novas dentro do intervalo", () => {
    const lines = parsePatch(patch);
    expect(lines.filter((l) => inRange(l, { start: 9, end: 10 })).map((l) => l.text)).toEqual(["+nova", "+outra"]);
    expect(lines.some((l) => inRange(l, undefined))).toBe(false);
  });
});

describe("link para o arquivo no host", () => {
  it("GitHub: aba de arquivos ancorada no sha256 do caminho e nas linhas", async () => {
    const url = await hostFileUrl("https://github.com/o/r/pull/42", "README.md", { start: 3, end: 7 });
    // sha256("README.md")
    expect(url).toBe("https://github.com/o/r/pull/42/files#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R3-R7");
    expect(await hostFileUrl("https://github.com/o/r/pull/42/", "README.md")).toBe(
      "https://github.com/o/r/pull/42/files#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5",
    );
  });

  it("GitLab: a aba de mudanças do MR", async () => {
    expect(await hostFileUrl("https://gitlab.com/g/r/-/merge_requests/9", "a.ts")).toBe("https://gitlab.com/g/r/-/merge_requests/9/diffs");
  });
});

describe("perguntar sobre uma parada", () => {
  it("leva o PR, a parada, os arquivos, o trecho e termina na pergunta da pessoa", () => {
    const p = askPrompt({ item, stop: guide.stops[1], index: 1, total: 3, summary: guide.summary, headSha: "0123456789abcdef" });
    expect(p).toContain('pull request #42 "Cache de cota" (https://github.com/o/r/pull/42)');
    expect(p).toContain("feat/cota → dev, head 0123456789ab");
    expect(p).toContain("## Stop 2 of 3: O cache");
    expect(p).toContain("- src/cache.rs (lines 10-20)");
    expect(p).toContain("- TTL");
    expect(p).toContain("```diff\n+let ttl = 5;\n```");
    expect(p).toContain("- E a invalidação?");
    expect(p).toContain("Don't change files, push, or comment");
    expect(p.endsWith("My question: ")).toBe(true);
  });

  it("abre no worktree do PR quando ele está aberto", () => {
    const ws = [{ cwd: "/repo", branch: "dev" }, { cwd: "/wt/cota", branch: "feat/cota" }];
    expect(askWorkdir(ws, item, "/repo")).toBe("/wt/cota");
    expect(askWorkdir([{ cwd: "/repo", branch: "pr/42" }], item, "/x")).toBe("/repo");
    expect(askWorkdir([{ cwd: "/repo", branch: "dev" }], item, "/repo")).toBe("/repo");
  });
});
