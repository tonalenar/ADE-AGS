import { describe, expect, it } from "vitest";

import { emptyBoard } from "@/features/canvas/board";
import { boardKey, boardKeyOfTab, compareBoardKey, compareOfKey, conversationOfKey, missionOfKey } from "@/features/canvas/store";

describe("canvas da comparação", () => {
  it("a chave carrega a comparação e não se confunde com missão nem conversa", () => {
    const key = compareBoardKey("C:/p/app", "abc123");
    expect(compareOfKey(key)).toBe("abc123");
    expect(missionOfKey(key)).toBeNull();
    expect(conversationOfKey(key)).toBeNull();
    expect(compareOfKey(boardKey("C:/p/app"))).toBeNull();
    expect(compareOfKey(null)).toBeNull();
  });

  it("a aba de um worktree pertence ao canvas da comparação em que é nó", () => {
    const key = compareBoardKey("C:/p/app", "abc123");
    const boards = { [key]: { ...emptyBoard(), nodes: { t1: { x: 0, y: 0, w: 10, h: 10 } } } };
    expect(boardKeyOfTab({ id: "t1", cwd: "C:/Users/x/.ags/worktrees/1a2b3c4d" }, boards)).toBe(key);
    expect(boardKeyOfTab({ id: "outra", cwd: "C:/p/app" }, boards)).toBe(boardKey("C:/p/app"));
  });
});
