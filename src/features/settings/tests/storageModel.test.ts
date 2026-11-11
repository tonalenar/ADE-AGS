import { describe, expect, it } from "vitest";

import { formatBytes, storageTotals } from "../storageModel";
import type { StorageArea } from "../ipc";

describe("tamanhos na página Armazenamento", () => {
  it("formata em B, KB, MB e GB, com uma casa só abaixo de 10", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(34 * 1024 * 1024)).toBe("34 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("soma os totais e só o antigo das áreas que se limpam", () => {
    const areas: StorageArea[] = [
      { id: "database", bytes: 100, files: 3, oldBytes: 0, oldFiles: 0, cleanable: false },
      { id: "deviceCaptures", bytes: 50, files: 5, oldBytes: 20, oldFiles: 2, cleanable: true },
    ];
    expect(storageTotals(areas)).toEqual({ bytes: 150, files: 8, oldBytes: 20, oldFiles: 2 });
  });
});
