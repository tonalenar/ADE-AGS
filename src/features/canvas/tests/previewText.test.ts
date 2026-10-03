import { describe, expect, it } from "vitest";

import { cleanPreviewLines, isDecorativePreviewLine, sanitizePreviewLine } from "../previewText";

describe("terminal canvas preview text", () => {
  it("removes C0 and C1 controls while preserving useful text", () => {
    expect(sanitizePreviewLine("\u0000A\u0008\u000B\u000C\u000E\u001F B\u007F\u0085\u009F\t!"))
      .toBe("A B\t!");
  });

  it("detects lines made only of decorative Unicode blocks and whitespace", () => {
    expect(isDecorativePreviewLine("  ─│┘ ░█ ■● ⠋⣿  ")).toBe(true);
    expect(isDecorativePreviewLine("\t⠋ ⠙\t")).toBe(true);
    expect(isDecorativePreviewLine("  ")).toBe(false);
    expect(isDecorativePreviewLine("")).toBe(false);
    expect(isDecorativePreviewLine("50% ███")).toBe(false);
    expect(isDecorativePreviewLine("│ Status ─")).toBe(false);
  });

  it("sanitizes before filtering without changing the input", () => {
    const lines = ["\u0001⠋ ⠙\u009F", "\u0002Ready\u007F", "   ", "50% ███", "┌──┐"];
    expect(cleanPreviewLines(lines)).toEqual(["Ready", "   ", "50% ███"]);
    expect(lines[0]).toBe("\u0001⠋ ⠙\u009F");
  });
});
