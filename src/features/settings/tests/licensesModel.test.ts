import { describe, expect, it } from "vitest";

import { filterLicenses, licenseGroups, type LicenseItem } from "../licensesModel";

const items: LicenseItem[] = [
  { ecosystem: "npm", name: "react", version: "19.3.0", license: "MIT" },
  { ecosystem: "crates", name: "serde", version: "1.0.200", license: "MIT OR Apache-2.0" },
  { ecosystem: "npm", name: "@esbuild/aix-ppc64", version: "0.28.2", license: "MIT", lida: true, licencaDe: "@esbuild/darwin-arm64@0.28.2" },
  { ecosystem: "npm", name: "@emnapi/core", version: "1.11.1", license: null, lida: false },
  { ecosystem: "crates", name: "ring", version: "0.17.8", license: null },
];

describe("busca na lista de licenças", () => {
  it("busca vazia devolve tudo, na ordem do arquivo", () => {
    expect(filterLicenses(items, "  ")).toEqual(items);
  });

  it("acha pelo nome, pela versão, pelo ecossistema e pela licença, sem caixa nem acento", () => {
    expect(filterLicenses(items, "REACT").map((i) => i.name)).toEqual(["react"]);
    expect(filterLicenses(items, "1.0.200").map((i) => i.name)).toEqual(["serde"]);
    expect(filterLicenses(items, "crates").map((i) => i.name)).toEqual(["serde", "ring"]);
    expect(filterLicenses(items, "apache").map((i) => i.name)).toEqual(["serde"]);
  });

  it("cada palavra da busca tem de aparecer em algum campo", () => {
    expect(filterLicenses(items, "serde apache").map((i) => i.name)).toEqual(["serde"]);
    expect(filterLicenses(items, "serde gpl")).toEqual([]);
  });
});

describe("contagem por licença", () => {
  it("agrupa pela licença declarada, do mais comum; o grupo sem licença fica por último, mesmo empatado", () => {
    const groups = licenseGroups(items);
    expect(groups[0]).toEqual({ license: "MIT", count: 2 });
    expect(groups[groups.length - 1]).toEqual({ license: null, count: 2 });
    expect(groups.find((g) => g.license === "MIT OR Apache-2.0")?.count).toBe(1);
  });
});
