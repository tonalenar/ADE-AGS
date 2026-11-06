import { describe, expect, it } from "vitest";

import { sharedDevices } from "../devicesModel";
import { initialSurfaces } from "../store";

describe("superfícies ao reabrir o app", () => {
  it("o painel que volta num aparelho já o tem aberto, e ele é compartilhado com os agentes", () => {
    // O app reabre com o iPhone à vista (aba salva). Sem isto, `surfaces` vinha vazio e os agentes não viam o aparelho.
    const surfaces = initialSurfaces("ios");
    expect(surfaces).toEqual(["ios"]);
    const shared = sharedDevices(surfaces, { ios: "7952A8EA", android: null }, { ios: "iPhone 17e", android: null });
    expect(shared).toEqual([{ kind: "ios", name: "iPhone 17e", udid: "7952A8EA" }]);
  });

  it("Resumo, Diff, vazio ou painel fechado não abrem superfície nenhuma", () => {
    for (const panel of ["diff", "empty", null] as const) expect(initialSurfaces(panel)).toEqual([]);
    expect(initialSurfaces("android")).toEqual(["android"]);
    expect(initialSurfaces("browser")).toEqual(["browser"]);
  });
});
