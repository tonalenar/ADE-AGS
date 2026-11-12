import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testing = process.argv.includes("--test");
if (process.platform !== "darwin") {
  console.log("[media-tools] helper Swift disponível só no macOS");
  process.exit(0);
}

const target = process.env.CC_CLI_TARGET ?? "";
const arch = target.startsWith("x86_64") ? "x86_64" : target.startsWith("aarch64") ? "arm64" : process.arch === "x64" ? "x86_64" : "arm64";
const work = mkdtempSync(join(tmpdir(), "ade-media-tools-"));
const source = join(root, "src-tauri", "helpers", "media-tools", "main.swift");
const output = join(work, "ade-image-tools");
const destination = join(root, "src-tauri", "binaries", "ade-image-tools");
try {
  execFileSync("swiftc", ["-O", "-swift-version", "5", "-target", `${arch}-apple-macos14.0`, "-module-cache-path", join(work, "mc"), source, "-o", output], { stdio: "inherit" });
  if (testing) {
    execFileSync(output, ["--test"], { stdio: "inherit" });
    console.log("[media-tools] testes sintéticos de redimensionamento e remoção de fundo passaram");
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    execFileSync("cp", [output, destination], { stdio: "inherit" });
    console.log(`[media-tools] ade-image-tools (${arch}) pronto para empacotar`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
