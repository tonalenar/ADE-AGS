import { describe, expect, it } from "vitest";

import { workspaceChoiceOf } from "../projectDefaultsModel";

describe("o workspace padrão do projeto na tela", () => {
  it("sem valor herda, e o booleano vira worktree ou checkout atual", () => {
    expect(workspaceChoiceOf(undefined)).toBe("inherit");
    expect(workspaceChoiceOf(true)).toBe("worktree");
    expect(workspaceChoiceOf(false)).toBe("local");
  });
});
