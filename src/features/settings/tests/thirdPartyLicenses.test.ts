import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import data from "@/features/settings/licenses.generated.json";
import type { LicensesData } from "@/features/settings/licensesModel";
import {
  collectCrates,
  collectNpm,
  nodeModulesPath,
  npmLicense,
  parseBunLock,
  platformFamily,
  splitNameVersion,
} from "../../../../scripts/gen-licenses.mjs";

const root = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

describe("o arquivo de licenças está em dia com o projeto", () => {
  const { itens } = data as LicensesData;

  it("cada item tem nome, versão e um ecossistema conhecido, sem repetir", () => {
    const chaves = new Set<string>();
    for (const item of itens) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.version.length).toBeGreaterThan(0);
      expect(["npm", "crates"]).toContain(item.ecosystem);
      const chave = `${item.ecosystem}:${item.name}@${item.version}`;
      expect(chaves.has(chave)).toBe(false);
      chaves.add(chave);
    }
  });

  it("a contagem do arquivo bate com a lista", () => {
    expect(data.contagem.total).toBe(itens.length);
    expect(data.contagem.npm).toBe(itens.filter((i) => i.ecosystem === "npm").length);
    expect(data.contagem.crates).toBe(itens.filter((i) => i.ecosystem === "crates").length);
  });

  it("toda dependência de produção do package.json aparece na lista", () => {
    const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const nomes = new Set(itens.filter((i) => i.ecosystem === "npm").map((i) => i.name));
    const faltando = Object.keys(pkg.dependencies ?? {}).filter((dep) => !nomes.has(dep));
    expect(faltando).toEqual([]);
  });

  it("toda crate externa do Cargo.lock aparece na lista", () => {
    const lock = readFileSync(root("src-tauri/Cargo.lock"), "utf8");
    const externas = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry/g)];
    const chaves = new Set(itens.filter((i) => i.ecosystem === "crates").map((i) => `${i.name}@${i.version}`));
    const faltando = externas.map((m) => `${m[1]}@${m[2]}`).filter((c) => !chaves.has(c));
    expect(faltando).toEqual([]);
  });

  it("um item que não foi lido nesta máquina sai sem licença, nunca com um chute", () => {
    for (const item of itens) {
      if (item.lida === false) expect(item.license).toBeNull();
    }
  });
});

describe("o gerador (scripts/gen-licenses.mjs)", () => {
  it("separa nome e versão mesmo com escopo", () => {
    expect(splitNameVersion("@esbuild/aix-ppc64@0.28.2")).toEqual({ name: "@esbuild/aix-ppc64", version: "0.28.2" });
    expect(splitNameVersion("react@19.3.0")).toEqual({ name: "react", version: "19.3.0" });
  });

  it("acha o caminho em node_modules de um pacote aninhado", () => {
    expect(nodeModulesPath("react")).toBe("node_modules/react");
    expect(nodeModulesPath("@esbuild/darwin-arm64")).toBe("node_modules/@esbuild/darwin-arm64");
    expect(nodeModulesPath("vite/esbuild/@esbuild/aix-ppc64")).toBe("node_modules/vite/node_modules/esbuild/node_modules/@esbuild/aix-ppc64");
  });

  it("lê a licença em todas as formas que o package.json usa", () => {
    expect(npmLicense({ license: "MIT" })).toBe("MIT");
    expect(npmLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(npmLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("MIT OR Apache-2.0");
    expect(npmLicense({})).toBeNull();
  });

  it("aceita vírgula final no bun.lock", () => {
    expect(parseBunLock('{ "a": [1,], }')).toEqual({ a: [1] });
  });

  it("um binário de plataforma leva a licença do irmão da mesma família e versão, e diz de onde veio", () => {
    expect(platformFamily("@esbuild/aix-ppc64")).toBe("@esbuild");
    const lock = JSON.stringify({
      packages: {
        "@esbuild/darwin-arm64": ["@esbuild/darwin-arm64@0.28.2", "", {}, "x"],
        "@esbuild/aix-ppc64": ["@esbuild/aix-ppc64@0.28.2", "", {}, "x"],
        "@emnapi/core": ["@emnapi/core@1.11.1", "", {}, "x"],
      },
    });
    const reader = (path: string) => (path === "node_modules/@esbuild/darwin-arm64" ? { version: "0.28.2", license: "MIT" } : null);
    const out = collectNpm(lock, reader);
    expect(out.items.find((i) => i.name === "@esbuild/aix-ppc64")).toMatchObject({ license: "MIT", licencaDe: "@esbuild/darwin-arm64@0.28.2" });
    // Pacote comum ausente não ganha licença de ninguém: sai como não lido.
    expect(out.items.find((i) => i.name === "@emnapi/core")).toMatchObject({ license: null, lida: false });
    expect(out.missing).toEqual(["@emnapi/core@1.11.1"]);
  });

  it("crates próprias (sem source) ficam de fora da lista", () => {
    const out = collectCrates({
      packages: [
        { name: "ade-ags", version: "0.1.0", source: null, license: "MIT" },
        { name: "serde", version: "1.0.200", source: "registry+https://github.com/rust-lang/crates.io-index", license: "MIT OR Apache-2.0" },
      ],
    });
    expect(out).toEqual([{ ecosystem: "crates", name: "serde", version: "1.0.200", license: "MIT OR Apache-2.0" }]);
  });
});
