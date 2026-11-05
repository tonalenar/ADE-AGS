/**
 * Compila o helper do espelhamento de iPhone (`src-tauri/helpers/iphone-mirror`, Swift) e o deixa em
 * `src-tauri/binaries/ade-iphone-mirror`, que `bundle.resources` leva para dentro do `.app`.
 *
 * Só no macOS e só com o Xcode 27 (o CoreDevice fica em /Library/Developer/PrivateFrameworks). Sem eles, avisa e
 * sai com 0: o app compila e abre do mesmo jeito, e o seletor diz que o espelhamento precisa do Xcode.
 *
 * - `--test`: compila e roda os testes da parte pura (RTCP), sem gerar o helper.
 * - `CC_CLI_TARGET`: o mesmo triple do `stage-cli` (`aarch64-apple-darwin`, `x86_64-apple-darwin`).
 * - `CC_CLI_STRICT=1`: uma falha corta o build.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "src-tauri", "helpers", "iphone-mirror");
const dest = join(root, "src-tauri", "binaries", "ade-iphone-mirror");
const frameworks = "/Library/Developer/PrivateFrameworks";
const strict = process.env.CC_CLI_STRICT === "1";
const testing = process.argv.includes("--test");

function skip(why) {
  console.log(`[iphone-mirror] ${why}: o app sai sem o espelhamento de iPhone.`);
  process.exit(strict && process.platform === "darwin" ? 1 : 0);
}

if (process.platform !== "darwin") skip("não é macOS");
const triple = process.env.CC_CLI_TARGET || "";
const arch = triple.startsWith("x86_64") ? "x86_64" : triple.startsWith("aarch64") ? "arm64" : process.arch === "x64" ? "x86_64" : "arm64";
const target = `${arch}-apple-macos14.0`;

if (!testing && !existsSync(join(frameworks, "CoreDevice.framework"))) skip("o CoreDevice do Xcode 27 não está neste Mac");

const sources = join(helper, "Sources");
const work = mkdtempSync(join(tmpdir(), "ade-iphone-mirror-"));
let failed = false;
try {
  if (testing) runTests();
  else build();
} catch (error) {
  console.error(`[iphone-mirror] ${testing ? "os testes falharam" : "não deu para compilar o helper"}: ${error.message}`);
  failed = strict || testing;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);

function runTests() {
  const out = join(work, "testes");
  execFileSync("swiftc", ["-O", "-target", target, "-module-cache-path", join(work, "mc"), join(sources, "Rtcp.swift"), join(helper, "Tests", "main.swift"), "-o", out], { stdio: "inherit" });
  execFileSync(out, [], { stdio: "inherit" });
}

function build() {

  // As interfaces escritas à mão vão para o nome da arquitetura pedida.
  const stubs = join(work, "stubs");
  for (const module of readdirSync(join(helper, "stubs"))) {
    const from = join(helper, "stubs", module);
    const to = join(stubs, module);
    mkdirSync(to, { recursive: true });
    const text = readFileSync(join(from, "arm64-apple-macos.swiftinterface"), "utf8").replace("-target arm64-apple-macos14.0", `-target ${target}`);
    writeFileSync(join(to, `${arch}-apple-macos.swiftinterface`), text);
  }
  const object = join(work, "Negociador.o");
  execFileSync("clang", ["-c", "-fobjc-arc", "-O2", "-target", target, join(sources, "Negociador.m"), "-o", object], { stdio: "inherit" });
  const built = join(work, "ade-iphone-mirror");
  execFileSync("swiftc", [
    "-O", "-swift-version", "5", "-target", target, "-module-cache-path", join(work, "mc"),
    "-I", stubs, "-F", frameworks, "-framework", "CoreDevice",
    "-Xlinker", "-rpath", "-Xlinker", frameworks,
    "-import-objc-header", join(sources, "Negociador.h"),
    join(sources, "main.swift"), join(sources, "Rtcp.swift"), object, "-o", built,
  ], { stdio: "inherit" });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(built, dest);
  console.log(`[iphone-mirror] ade-iphone-mirror (${arch}) pronto para empacotar`);
}
