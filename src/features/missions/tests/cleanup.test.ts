import { describe, expect, it } from "vitest";

import { canConfirmCleanup, cleanupBlockers, formatBytes, totalBytes, type CleanupReport } from "../cleanup";

const entry = (blockers: string[] = [], sizeBytes = 1024) => ({ missionId: "m", root: `r${blockers.length}${sizeBytes}`, branch: "b", sizeBytes, blockers, removed: false });
const report = (entries: ReturnType<typeof entry>[], dryRun = true): CleanupReport => ({ dryRun, entries });

describe("cleanup", () => {
  it("só confirma com algo a limpar, sem bloqueios e em simulação", () => {
    expect(canConfirmCleanup(report([entry()]))).toBe(true);
    expect(canConfirmCleanup(report([]))).toBe(false);
    expect(canConfirmCleanup(report([entry(), entry(["2 arquivos sem commit"])]))).toBe(false);
    expect(canConfirmCleanup(report([entry()], false))).toBe(false);
  });
  it("junta os bloqueios e soma os tamanhos", () => {
    const r = report([entry(["a"], 100), entry(["b", "c"], 50)]);
    expect(cleanupBlockers(r)).toEqual(["a", "b", "c"]);
    expect(totalBytes(r)).toBe(150);
  });
  it("formata bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(-1)).toBe("—");
  });
});
