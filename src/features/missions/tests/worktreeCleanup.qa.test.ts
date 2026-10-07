import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canConfirmCleanup,
  cleanupBlockers,
  formatBytes,
  missionCleanup,
  totalBytes,
  type CleanupEntry,
  type CleanupReport,
} from "../cleanup";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = vi.mocked(invoke);

describe("worktree cleanup - código de produção (cleanup.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const entry = (over: Partial<CleanupEntry> = {}): CleanupEntry => ({
    missionId: "m-1",
    root: "C:/Users/test/.ags/worktrees/wt-1",
    branch: "cc/mission-1",
    sizeBytes: 1024 * 1024 * 5, // 5 MB
    blockers: [],
    removed: false,
    ...over,
  });

  it("dry-run limpo: nenhum bloqueador e confirmação permitida", () => {
    const report: CleanupReport = {
      dryRun: true,
      entries: [
        entry({ blockers: [] }),
        entry({ root: "C:/Users/test/.ags/worktrees/wt-2", branch: "cc/mission-2", blockers: [] }),
      ],
    };

    expect(cleanupBlockers(report)).toEqual([]);
    expect(canConfirmCleanup(report)).toBe(true);
    expect(totalBytes(report)).toBe(10 * 1024 * 1024);
  });

  it("não permite confirmar se dryRun for falso, mesmo sem bloqueadores", () => {
    const report: CleanupReport = {
      dryRun: false,
      entries: [entry({ blockers: [] })],
    };

    expect(cleanupBlockers(report)).toEqual([]);
    expect(canConfirmCleanup(report)).toBe(false);
  });

  it("não permite confirmar se lista de entradas estiver vazia", () => {
    const report: CleanupReport = {
      dryRun: true,
      entries: [],
    };

    expect(canConfirmCleanup(report)).toBe(false);
    expect(totalBytes(report)).toBe(0);
  });

  it("alterações não commitadas geram bloqueador e impedem confirmação", () => {
    const dirtyBlocker = "alterações não commitadas: README.md, novo.txt";
    const report: CleanupReport = {
      dryRun: true,
      entries: [entry({ blockers: [dirtyBlocker] })],
    };

    const blockers = cleanupBlockers(report);
    expect(blockers).toContain(dirtyBlocker);
    expect(canConfirmCleanup(report)).toBe(false);
  });

  it("commits fora do master geram bloqueador e impedem exclusão", () => {
    const unmergedBlocker = "commits fora de origin/master: abc1234 feat: novidade";
    const report: CleanupReport = {
      dryRun: true,
      entries: [entry({ blockers: [unmergedBlocker] })],
    };

    const blockers = cleanupBlockers(report);
    expect(blockers).toContain(unmergedBlocker);
    expect(canConfirmCleanup(report)).toBe(false);
  });

  it("terminais abertos ou missão em andamento bloqueiam a limpeza atômica", () => {
    const tabBlocker = "terminal ainda aberto neste worktree";
    const missionBlocker = "missão em andamento: running";
    const report: CleanupReport = {
      dryRun: true,
      entries: [
        entry({ blockers: [tabBlocker] }),
        entry({ root: "C:/Users/test/.ags/worktrees/wt-3", branch: "cc/mission-3", blockers: [missionBlocker] }),
      ],
    };

    const blockers = cleanupBlockers(report);
    expect(blockers).toHaveLength(2);
    expect(blockers).toContain(tabBlocker);
    expect(blockers).toContain(missionBlocker);
    expect(canConfirmCleanup(report)).toBe(false);
  });

  it("bloqueador em qualquer uma das entradas invalida toda a limpeza", () => {
    const report: CleanupReport = {
      dryRun: true,
      entries: [
        entry({ blockers: [] }), // limpo
        entry({ blockers: ["branch do worktree diverge do registro"] }), // bloqueado
      ],
    };

    expect(cleanupBlockers(report)).toEqual(["branch do worktree diverge do registro"]);
    expect(canConfirmCleanup(report)).toBe(false);
  });

  describe("formatBytes", () => {
    it("formata diferentes ordens de grandeza em unidades legíveis", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1048576)).toBe("1.0 MB");
      expect(formatBytes(1073741824)).toBe("1.0 GB");
    });

    it("retorna travessão para valores inválidos ou negativos", () => {
      expect(formatBytes(-1)).toBe("—");
      expect(formatBytes(Number.NaN)).toBe("—");
      expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
    });
  });

  describe("missionCleanup invoke contract", () => {
    it("chama invoke com dryRun = true por padrão", async () => {
      const mockReport: CleanupReport = { dryRun: true, entries: [] };
      mockedInvoke.mockResolvedValueOnce(mockReport);

      const result = await missionCleanup("mission-42");
      expect(mockedInvoke).toHaveBeenCalledWith("mission_cleanup", {
        missionId: "mission-42",
        dryRun: true,
      });
      expect(result).toEqual(mockReport);
    });

    it("chama invoke com dryRun = false quando explicitamente solicitado", async () => {
      const mockReport: CleanupReport = { dryRun: false, entries: [] };
      mockedInvoke.mockResolvedValueOnce(mockReport);

      const result = await missionCleanup("mission-42", false);
      expect(mockedInvoke).toHaveBeenCalledWith("mission_cleanup", {
        missionId: "mission-42",
        dryRun: false,
      });
      expect(result).toEqual(mockReport);
    });
  });
});
