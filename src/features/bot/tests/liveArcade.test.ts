import { describe, expect, it } from "vitest";

import {
  deriveArcadeScene,
  failureCount,
  retryCount,
  taskStage,
  type ArcadeTask,
} from "../liveArcadeModel";

const task = (id: string, patch: Partial<ArcadeTask> = {}): ArcadeTask => ({
  id,
  title: id,
  status: "pending",
  dependsOn: [],
  ...patch,
});

describe("live arcade stage derivation", () => {
  it("keeps unmeasured stages unknown and marks opening only from recorded boot or briefing spans", () => {
    const empty = deriveArcadeScene({ missionStatus: "running", tasks: [], timings: null, reviews: null });
    expect(empty.stages.map((stage) => stage.status)).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);

    const opened = deriveArcadeScene({
      missionStatus: "running",
      tasks: [],
      timings: [{ kind: "turn", detail: "briefing" }],
      reviews: null,
    });
    expect(opened.stages[0]).toEqual({ id: "opening", status: "done" });
  });

  it("assigns test and review floors from recorded roles or check results", () => {
    expect(taskStage(task("qa", { role: "quality-assurance" }))).toBe("tests");
    expect(taskStage(task("review", { role: "code-reviewer" }))).toBe("review");
    expect(taskStage(task("checked", { checks: ["passed"] }))).toBe("tests");
    expect(taskStage(task("implementation", { role: "worker" }))).toBe("work");
  });

  it("derives current floor from real task and test statuses, with dependency ladders", () => {
    const scene = deriveArcadeScene({
      missionStatus: "running",
      tasks: [
        task("build", { status: "done", role: "worker" }),
        task("checks", { status: "ready", role: "qa", dependsOn: ["build", "unknown"] }),
      ],
      timings: [{ kind: "boot" }],
      reviews: null,
    });

    expect(scene.currentStage).toBe("tests");
    expect(scene.stages).toEqual([
      { id: "opening", status: "done" },
      { id: "work", status: "done" },
      { id: "tests", status: "active" },
      { id: "review", status: "unknown" },
      { id: "delivery", status: "unknown" },
    ]);
    expect(scene.dependencies).toEqual([{ from: "build", to: "checks" }]);
  });

  it("uses recorded delivery review and mission outcome", () => {
    const accepted = deriveArcadeScene({
      missionStatus: "done",
      tasks: [],
      timings: null,
      reviews: [{ review: "accepted" }],
    });
    expect(accepted.stages.find((stage) => stage.id === "review")?.status).toBe("done");
    expect(accepted.stages.find((stage) => stage.id === "delivery")?.status).toBe("done");

    const rejected = deriveArcadeScene({
      missionStatus: "failed",
      tasks: [],
      timings: null,
      reviews: [{ review: "rejected" }],
    });
    expect(rejected.currentStage).toBe("review");
    expect(rejected.stages.find((stage) => stage.id === "review")?.status).toBe("failed");
    expect(rejected.stages.find((stage) => stage.id === "delivery")?.status).toBe("failed");
  });

  it("counts persisted retries and failures as lives", () => {
    const tasks = [
      task("retry", { attempt: 3 }),
      task("failure", { status: "failed" }),
      task("first-try", { attempt: 1 }),
    ];
    expect(retryCount(tasks)).toBe(2);
    expect(failureCount(tasks)).toBe(1);
  });
});
