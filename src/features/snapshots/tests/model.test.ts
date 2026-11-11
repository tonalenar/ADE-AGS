import { describe, expect, it } from "vitest";

import type { SnapshotItem } from "../ipc";
import { snapshotCanCopy, snapshotLabel, snapshotTime } from "../model";

const base: SnapshotItem = {
  id: "ADE-AGS_SnapShot_2026-11-10_21-00-00_aaaa",
  path: "/Users/ton/Pictures/ADE AGS/ADE-AGS_SnapShot_2026-11-10_21-00-00_aaaa.png",
  app: null,
  title: null,
  scope: null,
  capturedAt: null,
  modifiedMs: 1_700_000_000_000,
  bytes: 1024,
};

describe("legenda de uma captura", () => {
  it("junta o app e o título da janela, sem espaços sobrando", () => {
    expect(snapshotLabel({ ...base, app: " Terminal ", title: "ade-ags" })).toBe("Terminal · ade-ags");
  });

  it("some sem legenda, ou com partes vazias", () => {
    expect(snapshotLabel(base)).toBe("");
    expect(snapshotLabel({ ...base, app: "  ", title: "Safari" })).toBe("Safari");
  });
});

describe("instante de uma captura", () => {
  it("usa o horário do JSON quando ele lê", () => {
    expect(snapshotTime({ ...base, capturedAt: "2026-11-10T21:00:00-03:00" })).toBe(Date.parse("2026-11-10T21:00:00-03:00"));
  });

  it("cai no horário do arquivo sem JSON ou com data inválida", () => {
    expect(snapshotTime(base)).toBe(base.modifiedMs);
    expect(snapshotTime({ ...base, capturedAt: "ontem à tarde" })).toBe(base.modifiedMs);
  });
});

describe("copiar para a área de transferência", () => {
  it("só existe no macOS, que é onde a cópia de PNG do app roda", () => {
    expect(snapshotCanCopy("macos")).toBe(true);
    expect(snapshotCanCopy("windows")).toBe(false);
    expect(snapshotCanCopy("linux")).toBe(false);
  });
});
