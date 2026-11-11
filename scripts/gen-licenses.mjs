#!/usr/bin/env node
/**
 * Gera a lista de licenças das dependências que a tela Configurações → Licenças mostra.
 *
 * Fontes, sem rede:
 * - npm: as versões travadas no `bun.lock`, e a licença de cada uma no `package.json` que está em `node_modules`.
 * - crates: o `src-tauri/Cargo.lock`, lido por `cargo metadata --locked --offline`.
 *
 * Pacote que não dá para ler nesta máquina (nem instalado, nem no cache do bun, nem irmão de plataforma)
 * sai como "não lido", com licença nula: uma licença inventada seria pior que nenhuma. Uso: `bun run licenses:gen`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/features/settings/licenses.generated.json");

/** Separa "nome@versão" sem se perder com o @ inicial de pacotes escopados. */
export function splitNameVersion(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) throw new Error(`Entrada sem versão no bun.lock: ${spec}`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Converte a chave de um pacote do bun.lock no caminho em node_modules. Uma chave aninhada é
 * "pai/filho" (ou "@escopo/pai/filho"): cada pedaço vira `node_modules/<pedaço>`.
 */
export function nodeModulesPath(key) {
  const parts = [];
  for (let i = 0; i < key.length;) {
    const slash = key.indexOf("/", i);
    const end = key[i] === "@" && slash !== -1 ? key.indexOf("/", slash + 1) : slash;
    const stop = end === -1 ? key.length : end;
    parts.push(key.slice(i, stop));
    i = stop + 1;
  }
  return parts.reduce((path, part) => join(path, "node_modules", part), "");
}

/** A licença que o package.json declara, em texto. Formas antigas (objeto, lista) viram uma string. */
export function npmLicense(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === "object" && typeof pkg.license.type === "string") return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses)) {
    const names = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (names.length) return names.join(" OR ");
  }
  return null;
}

/** O bun.lock aceita vírgula final (é JSON com vírgulas sobrando); tira antes de ler. */
export function parseBunLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

/** Nomes de binários de plataforma (`@esbuild/aix-ppc64`, `lightningcss-linux-x64-gnu`…). */
const PLATFORM_TOKEN = /[-/](aix|android|darwin|freebsd|linux|openbsd|sunos|win32|wasm32|x64|arm64|ia32|ppc64|s390x|riscv64|loong64|musl|gnu|msvc|x86)/;

/**
 * A família de um binário de plataforma. Escopado: o escopo (`@esbuild/aix-ppc64` e `@esbuild/darwin-arm64`
 * são da mesma família). Sem escopo: o que vem antes do primeiro hífen (`lightningcss-linux-x64-gnu` → `lightningcss`).
 */
export function platformFamily(name) {
  if (name.startsWith("@")) return name.split("/")[0];
  return name.split("-")[0];
}

/**
 * Lê as licenças de npm. Um pacote de plataforma que não foi instalado nesta máquina (o bun só baixa o
 * do sistema atual) leva a licença do irmão da mesma família e da mesma versão, e o item diz de onde veio.
 * Qualquer outro pacote ausente fica em `missing`: sem licença lida, não se inventa.
 */
export function collectNpm(lockText, readPackageJson) {
  const lock = parseBunLock(lockText);
  const items = [];
  const pending = [];
  const installedByFamily = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const spec = Array.isArray(entry) ? entry[0] : null;
    if (typeof spec !== "string") continue;
    const { name, version } = splitNameVersion(spec);
    const pkg = readPackageJson(nodeModulesPath(key), name, version);
    if (pkg) {
      items.push({ ecosystem: "npm", name, version, license: npmLicense(pkg) });
      installedByFamily.set(`${platformFamily(name)}@${version}`, { name, version, license: npmLicense(pkg) });
    } else {
      pending.push({ name, version });
    }
  }
  const missing = [];
  for (const { name, version } of pending) {
    const sibling = PLATFORM_TOKEN.test(name) ? installedByFamily.get(`${platformFamily(name)}@${version}`) : undefined;
    if (sibling) {
      items.push({ ecosystem: "npm", name, version, license: sibling.license, licencaDe: `${sibling.name}@${sibling.version}` });
    } else {
      // Não lido nesta máquina: sem licença inventada. A lista mostra "não lida" e o script avisa o que faltou.
      missing.push(`${name}@${version}`);
      items.push({ ecosystem: "npm", name, version, license: null, lida: false });
    }
  }
  return { items, missing };
}

export function collectCrates(metadata) {
  return (metadata.packages ?? [])
    .filter((p) => p.source) // Os crates do próprio projeto têm `source` nulo: não são de terceiros.
    .map((p) => ({ ecosystem: "crates", name: p.name, version: p.version, license: p.license ?? null }));
}

export function sortItems(items) {
  const order = (a, b) => a.localeCompare(b, "en");
  return [...items].sort((a, b) => order(a.ecosystem, b.ecosystem) || order(a.name, b.name) || order(a.version, b.version));
}

/**
 * Procura o package.json de um pacote: no caminho do lock, no `node_modules` de cima e, por último, no
 * cache de download do próprio bun (`~/.bun/install/cache`), que guarda os pacotes já baixados. Só lê.
 */
function readNpmPackage(path, name, version) {
  const cache = join(homedir(), ".bun", "install", "cache", `${name}@${version}@@@1`, "package.json");
  for (const candidate of [join(ROOT, path, "package.json"), join(ROOT, "node_modules", name, "package.json"), cache]) {
    if (!existsSync(candidate)) continue;
    const pkg = JSON.parse(readFileSync(candidate, "utf8"));
    if (pkg.version === version) return pkg;
  }
  return null;
}

function main() {
  const lockText = readFileSync(join(ROOT, "bun.lock"), "utf8");
  const npm = collectNpm(lockText, readNpmPackage);
  if (npm.missing.length) {
    console.warn(`Não lidos nesta máquina (${npm.missing.length}): ${npm.missing.join(", ")}. Saem como "não lida"; rode \`bun install\` numa máquina com essas plataformas para lê-los.`);
  }
  let metadata;
  try {
    const stdout = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--manifest-path", join(ROOT, "src-tauri/Cargo.toml")], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`cargo metadata falhou (as crates precisam estar baixadas: rode \`cargo fetch --manifest-path src-tauri/Cargo.toml\`): ${error.message.split("\n")[0]}`);
  }
  const items = sortItems([...npm.items, ...collectCrates(metadata)]);
  const counts = {
    total: items.length,
    npm: items.filter((i) => i.ecosystem === "npm").length,
    crates: items.filter((i) => i.ecosystem === "crates").length,
    naoLidas: items.filter((i) => i.lida === false).length,
    semLicenca: items.filter((i) => !i.license).length,
  };
  const data = {
    gerado: "bun run licenses:gen",
    fontes: ["bun.lock + node_modules", "src-tauri/Cargo.lock (cargo metadata --locked --offline)"],
    contagem: counts,
    itens: items,
  };
  writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Licenças: ${counts.total} pacotes (${counts.npm} npm, ${counts.crates} crates); ${counts.naoLidas} não lidos, ${counts.semLicenca} sem licença declarada.`);
  console.log(`Gravado em ${OUT}`);
}

// Só roda quando chamado direto (os testes importam as funções puras sem efeito colateral).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
