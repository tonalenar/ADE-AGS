import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIRM_PREFS, parseConfirmPrefs } from "@/features/settings/confirmPreferences";

describe("confirmações da barra lateral", () => {
  it("excluir pede confirmação por padrão; desafixar e arquivar não", () => {
    expect(DEFAULT_CONFIRM_PREFS).toEqual({ unpin: false, archive: false, delete: true });
  });

  it("sem nada gravado, ou com lixo, volta ao padrão", () => {
    expect(parseConfirmPrefs(null)).toEqual(DEFAULT_CONFIRM_PREFS);
    expect(parseConfirmPrefs("texto")).toEqual(DEFAULT_CONFIRM_PREFS);
    expect(parseConfirmPrefs([1, 2])).toEqual(DEFAULT_CONFIRM_PREFS);
  });

  it("um valor que não é booleano cai no padrão daquela chave, sem atrapalhar as outras", () => {
    expect(parseConfirmPrefs({ unpin: "sim", archive: true, delete: 0 })).toEqual({ unpin: false, archive: true, delete: true });
  });

  it("uma chave gravada vale; as que faltam ficam no padrão", () => {
    expect(parseConfirmPrefs({ archive: true })).toEqual({ unpin: false, archive: true, delete: true });
    expect(parseConfirmPrefs({ delete: false })).toEqual({ unpin: false, archive: false, delete: false });
  });
});
