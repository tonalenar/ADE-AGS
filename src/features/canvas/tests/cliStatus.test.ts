import { describe, expect, it } from "vitest";
import { cliOutdatedDetail, type CliBuildStatus } from "../cliStatus";

const base: CliBuildStatus = { outdated: false, app: { version: "0.5.0", buildHash: "abcdef1234" }, cli: { version: "0.5.0", buildHash: "abcdef1234" }, path: "ags.exe", reason: null };

describe("cliOutdatedDetail", () => {
  it("em dia: sem aviso", () => expect(cliOutdatedDetail(base)).toBeNull());
  it("desatualizado: mostra as duas versões com o hash curto", () => {
    expect(cliOutdatedDetail({ ...base, outdated: true, cli: { version: "0.4.0", buildHash: "1111111999" } })).toEqual({ cli: "0.4.0 (1111111)", app: "0.5.0 (abcdef1)" });
  });
  it("sem CLI ao lado do app", () => {
    expect(cliOutdatedDetail({ ...base, outdated: true, cli: null })?.cli).toBe("?");
  });
});
