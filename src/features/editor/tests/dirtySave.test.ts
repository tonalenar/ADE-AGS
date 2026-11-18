import { describe, expect, it } from "vitest";

import { applyDiskReload, dirtyAfterSuccessfulSave } from "../dirtySave";

describe("A507 salvar", () => {
  it("edição durante a gravação deixa o arquivo sujo", () => {
    expect(dirtyAfterSuccessfulSave("aaa", "aaab")).toBe(true);
    expect(dirtyAfterSuccessfulSave("aaa", "aaa")).toBe(false);
  });
});

describe("A508 releitura", () => {
  it("não aplica o disco no editor se estiver sujo", () => {
    expect(applyDiskReload(true, true)).toBe(false);
    expect(applyDiskReload(false, true)).toBe(true);
  });
});
