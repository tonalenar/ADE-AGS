import { describe, expect, it } from "vitest";

import { ABSENT } from "../ipc";
import { bannerForConflict, expectedVersionForSave } from "../fileVersion";

describe("expectedVersionForSave", () => {
  it("manda a versão lida, para o backend recusar se um agente mudou o arquivo", () => {
    expect(expectedVersionForSave({ overwrite: false, deleted: false, version: "3:10:7" })).toBe("3:10:7");
  });

  it("sobrescrever explícito não confere nada", () => {
    expect(expectedVersionForSave({ overwrite: true, deleted: false, version: "3:10:7" })).toBeNull();
    expect(expectedVersionForSave({ overwrite: true, deleted: true, version: null })).toBeNull();
  });

  it("arquivo apagado recria com create_new, sem pisar quem recriou antes", () => {
    expect(expectedVersionForSave({ overwrite: false, deleted: true, version: "3:10:7" })).toBe(ABSENT);
  });

  it("sem versão lida, nunca vira sobrescrita cega", () => {
    expect(expectedVersionForSave({ overwrite: false, deleted: false, version: null })).toBe(ABSENT);
  });
});

describe("bannerForConflict", () => {
  it("separa arquivo que sumiu de arquivo que mudou", () => {
    expect(bannerForConflict({ kind: "conflict", mtime: null, version: null })).toBe("deleted");
    expect(bannerForConflict({ kind: "conflict", mtime: 1, version: "1:1:1" })).toBe("conflict");
  });
});
