import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/features/chat/diffModel";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@ export function a()",
  " um",
  "-dois",
  "+DOIS",
  "+tres",
  "\\ No newline at end of file",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("separa por arquivo, conta + e − e ignora o cabeçalho", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([["src/a.ts", 2, 1], ["img.png", 0, 0]]);
    expect(files[0]!.lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "add"]);
    expect(files[0]!.lines[2]).toEqual({ kind: "del", text: "dois" });
    expect(files[1]!.lines).toEqual([]);
  });

  it("texto vazio não tem arquivos", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
