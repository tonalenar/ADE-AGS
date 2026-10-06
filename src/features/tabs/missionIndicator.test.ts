import { describe, expect, it } from "vitest";

import { deriveMissionIndicator } from "./missionIndicator";

describe("deriveMissionIndicator", () => {
  it.each(["done", "failed", "cancelled"])("prioritizes final status %s over live signals", (status) => {
    expect(deriveMissionIndicator({ status, workingAgents: 3, needsAttention: true })).toEqual({
      state: status === "done" ? "done" : "failed", workingCount: 0,
    });
  });
  it("prioritizes attention while preserving the count of other working agents", () => {
    expect(deriveMissionIndicator({ status: "running", workingAgents: 2, needsAttention: true }))
      .toEqual({ state: "needsYou", workingCount: 2 });
  });
  it.each(["running", "draft"])("uses sustained activity for %s", (status) => {
    expect(deriveMissionIndicator({ status, workingAgents: 2, needsAttention: false }))
      .toEqual({ state: "working", workingCount: 2 });
  });
  it("keeps a running mission waiting without sustained output", () => {
    expect(deriveMissionIndicator({ status: "running", workingAgents: 0, needsAttention: false }))
      .toEqual({ state: "waiting", workingCount: 0 });
  });
  it.each(["draft", "", "unknown", "done_without_delivery"])("keeps %s idle without activity", (status) => {
    expect(deriveMissionIndicator({ status, workingAgents: 0, needsAttention: false }))
      .toEqual({ state: "idle", workingCount: 0 });
  });
  it.each([-1, NaN, Infinity])("rejects an invalid working count %s", (workingAgents) => {
    expect(deriveMissionIndicator({ status: "running", workingAgents, needsAttention: false }))
      .toEqual({ state: "waiting", workingCount: 0 });
  });
});
