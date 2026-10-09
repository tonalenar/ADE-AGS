import { describe, expect, it } from "vitest";
import { RECENT_FAILED_S, isArchivedMission } from "../groups";

describe("isArchivedMission", () => {
  const now = 1_000_000;
  it("terminada e cancelada sempre vão para arquivadas", () => {
    for (const status of ["done", "done_without_delivery", "cancelled"]) expect(isArchivedMission({ status, updatedAt: now }, now)).toBe(true);
  });
  it("falha recente fica na lista viva (dá para iniciar de novo); a antiga arquiva", () => {
    expect(isArchivedMission({ status: "failed", updatedAt: now - 60 }, now)).toBe(false);
    expect(isArchivedMission({ status: "failed", updatedAt: now - RECENT_FAILED_S }, now)).toBe(true);
  });
  it("rascunho e em andamento nunca arquivam", () => {
    expect(isArchivedMission({ status: "draft", updatedAt: 0 }, now)).toBe(false);
    expect(isArchivedMission({ status: "running", updatedAt: 0 }, now)).toBe(false);
  });
});
