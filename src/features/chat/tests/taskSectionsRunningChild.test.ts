import { describe, expect, it } from "vitest";

import { taskSections, type BgTask } from "../tasks/tasksModel";

const task = (over: Partial<BgTask>): BgTask => ({
  id: "x", toolUseId: null, parentId: null, kind: "shell", title: "", subagent: null, prompt: null, status: "completed",
  startedAt: 1, endedAt: 2, durationMs: null, summary: null, lastTool: null, background: true, stoppable: true, source: "events",
  ...over,
} as BgTask);

describe("o shell que um subagente lançou continua em execução depois de o subagente acabar", () => {
  it("um filho rodando de um pai concluído aparece em Em execução, e não some dentro de Concluído", () => {
    const parent = task({ id: "sub", status: "completed", endedAt: 10 });
    const child = task({ id: "shell", parentId: "sub", status: "running", endedAt: null });
    const { running, done } = taskSections([parent, child]);
    expect(running.map((n) => n.task.id)).toEqual(["shell"]);
    expect(done.map((n) => n.task.id)).toEqual(["sub"]);
    expect(done[0]!.children).toEqual([]);
  });
});
