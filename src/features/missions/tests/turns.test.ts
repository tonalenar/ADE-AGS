import { describe, expect, it } from "vitest";
import { TurnTracker } from "../turns";

const members = new Map([["tab", { mission: "m", actor: "Backend" }]]);
const output = (start: number, end: number) => new Map([["tab", { startedMs: start, lastOutputMs: end }]]);

describe("mission turn tracker", () => {
  it("records briefing once, preserves detail and records subsequent sustained turns", () => {
    const t = new TurnTracker();
    t.start("tab", "m", "Backend", 1000, "briefing");
    t.start("tab", "m", "Backend", 1001);
    expect(t.sample(output(1000, 4000), members, 4000)).toEqual([]);
    const [first] = t.sample(new Map(), members, 9000);
    expect(first.span).toMatchObject({ kind: "turn", startedMs: 1000, endedMs: 4000, detail: "briefing" });
    expect(t.sample(new Map(), members, 10000)).toEqual([]);
    expect(t.sample(output(11000, 15000), members, 15000)).toEqual([]);
    expect(t.sample(new Map(), members, 20000)[0].span).toMatchObject({ startedMs: 11000, endedMs: 15000, detail: "" });
  });

  it("ignores startup redraws but captures short submitted replies and delayed output", () => {
    const t = new TurnTracker();
    expect(t.sample(output(1000, 1100), members, 7000)).toEqual([]);
    t.start("tab", "m", "Backend", 8000);
    expect(t.sample(new Map(), members, 14000)).toEqual([]);
    t.sample(output(15000, 15100), members, 15100);
    expect(t.sample(new Map(), members, 20100)[0].span).toMatchObject({ startedMs: 8000, endedMs: 15100 });
  });

  it("flushes closed tabs and discards a submission without output", () => {
    const t = new TurnTracker();
    t.start("tab", "m", "Backend", 1000);
    t.sample(output(2000, 4000), members, 4000);
    expect(t.sample(new Map(), new Map(), 4500)).toHaveLength(1);
    t.start("tab", "m", "Backend", 6000);
    expect(t.sample(new Map(), new Map(), 7000)).toEqual([]);
  });
});
