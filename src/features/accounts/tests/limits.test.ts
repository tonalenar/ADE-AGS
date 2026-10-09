import { describe, expect, it, vi } from "vitest";

import { loadLimitsFor, loadLimitsTolerant, parseLimitsForm, type LimitsLoad } from "../limits";
import type { AccountLimits } from "../types";

const SAVED: AccountLimits = { maxConcurrent: 2, dailyBudgetUsd: 10 };

describe("account limits dialog", () => {
  it("refuses to save while the account limits have not loaded", () => {
    const loading: LimitsLoad = { status: "loading" };
    expect(parseLimitsForm(loading, "", "")).toEqual({ ok: false, problem: "notLoaded" });
  });

  it("refuses to save when reading the account limits failed, instead of writing nulls", async () => {
    const load = await loadLimitsFor("acc-1", () => Promise.reject(new Error("db locked")));
    expect(load).toEqual({ status: "error", message: "Error: db locked" });
    const set = vi.fn();
    const parsed = parseLimitsForm(load, "", "");
    if (parsed.ok) set(parsed.limits);
    expect(parsed).toEqual({ ok: false, problem: "notLoaded" });
    expect(set).not.toHaveBeenCalled();
  });

  it("starts from the limits on disk and saves what the form says", async () => {
    const load = await loadLimitsFor("acc-1", async () => SAVED);
    expect(load).toEqual({ status: "ready", limits: SAVED });
    expect(parseLimitsForm(load, "3", "7,5")).toEqual({ ok: true, limits: { maxConcurrent: 3, dailyBudgetUsd: 7.5 } });
    expect(parseLimitsForm(load, "", "")).toEqual({ ok: true, limits: { maxConcurrent: null, dailyBudgetUsd: null } });
  });

  it("keeps validating the fields once loaded", () => {
    const ready: LimitsLoad = { status: "ready", limits: SAVED };
    expect(parseLimitsForm(ready, "0", "")).toEqual({ ok: false, problem: "maxConcurrent" });
    expect(parseLimitsForm(ready, "", "-1")).toEqual({ ok: false, problem: "budget" });
  });
});

describe("loadLimitsTolerant", () => {
  it("keeps the other accounts' limits when one read fails", async () => {
    const get = (id: string) => (id === "bad" ? Promise.reject(new Error("nope")) : Promise.resolve({ ...SAVED, maxConcurrent: id.length }));
    await expect(loadLimitsTolerant(["a", "bad", "ccc"], get)).resolves.toEqual({
      a: { ...SAVED, maxConcurrent: 1 },
      ccc: { ...SAVED, maxConcurrent: 3 },
    });
  });
});
