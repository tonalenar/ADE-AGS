/** Prepara o CEF e os helpers assináveis em Contents/Frameworks. */
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (platform !== "darwin") process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
// O mesmo alvo do `stage-cli` (`CC_CLI_TARGET`): o build de release cruza arm64 → x86_64 no CI.
const target = process.env.CC_CLI_TARGET || "";
const targetDir = target ? join(tauriDir, "target", target, "release") : join(tauriDir, "target", "release");
const staging = join(tauriDir, "cef-bundle-staging", "Frameworks");
const cefArch = target ? (target.startsWith("aarch64") ? "aarch64" : "x86_64") : (arch === "arm64" ? "aarch64" : "x86_64");

const helperBuild = ["build", "--release", "--bin", "ade-ags-helper"];
if (target) helperBuild.push("--target", target);
execFileSync("cargo", helperBuild, { cwd: tauriDir, stdio: "inherit" });

const cefBuildRoot = join(targetDir, "build");
const cefBuild = readdirSync(cefBuildRoot)
  .filter((name) => name.startsWith("cef-dll-sys-"))
  .map((name) => join(cefBuildRoot, name, "out", `cef_macos_${cefArch}`))
  .find((path) => {
    try { return readdirSync(path).includes("Chromium Embedded Framework.framework"); } catch { return false; }
  });
if (!cefBuild) throw new Error(`Não achei a distribuição CEF macOS ${cefArch} em ${cefBuildRoot}.`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const cefFramework = join(staging, "Chromium Embedded Framework.framework");
cpSync(join(cefBuild, "Chromium Embedded Framework.framework"), cefFramework, { recursive: true });

// O CEF vem com assinatura de link ad hoc, sem envelope de recursos do framework.
// Assinamos o bundle aqui para o selo sobreviver à cópia do Tauri e ao deep verify.
if (process.env.APPLE_SIGNING_IDENTITY) {
  execFileSync("codesign", [
    "--force", "--deep", "--options", "runtime", "--timestamp", "--sign",
    process.env.APPLE_SIGNING_IDENTITY, cefFramework,
  ], { stdio: "inherit" });
}

const helpers = ["ADE AGS Helper", "ADE AGS Helper (GPU)", "ADE AGS Helper (Renderer)", "ADE AGS Helper (Plugin)", "ADE AGS Helper (Alerts)"];
// Cada helper com um identificador próprio, filho do app (o sandbox do GPU usa o do helper).
const helperId = (helper) => {
  const kind = helper.match(/\((\w+)\)$/)?.[1]?.toLowerCase();
  return kind ? `com.luis.controlcode.helper.${kind}` : "com.luis.controlcode.helper";
};
for (const helper of helpers) {
  const contents = join(staging, `${helper}.app`, "Contents");
  const macos = join(contents, "MacOS");
  mkdirSync(macos, { recursive: true });
  const executable = join(macos, helper);
  cpSync(join(targetDir, "ade-ags-helper"), executable);
  chmodSync(executable, 0o755);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>${helper}</string>
<key>CFBundleIdentifier</key><string>${helperId(helper)}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleSignature</key><string>????</string>
<key>CFBundleName</key><string>${helper}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.14.0</string>
<key>CFBundleVersion</key><string>1.14.0</string>
<key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
<key>LSFileQuarantineEnabled</key><true/>
<key>LSUIElement</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSBluetoothAlwaysUsageDescription</key><string>ADE AGS</string>
<key>NSCameraUsageDescription</key><string>ADE AGS precisa de acesso à câmera para páginas que você permitir.</string>
<key>NSMicrophoneUsageDescription</key><string>ADE AGS precisa de acesso ao microfone para páginas que você permitir.</string>
<key>NSLocationWhenInUseUsageDescription</key><string>ADE AGS precisa da localização para páginas que você permitir.</string>
<key>NSWebBrowserPublicKeyCredentialUsageDescription</key><string>ADE AGS usa passkeys quando o site e o sistema oferecem suporte.</string>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>`;
  writeFileSync(join(contents, "Info.plist"), plist);

  // O bundler Tauri não cria o selo de recursos dos .app adicionados por bundle.macOS.files.
  if (process.env.APPLE_SIGNING_IDENTITY) {
    const signingArgs = ["--force", "--options", "runtime", "--timestamp", "--sign", process.env.APPLE_SIGNING_IDENTITY];
    if (helper.endsWith("(GPU)") || helper.endsWith("(Renderer)")) {
      signingArgs.push("--entitlements", join(tauriDir, "CefHelperJitEntitlements.plist"));
    } else {
      signingArgs.push("--entitlements", join(tauriDir, "CefHelperLibEntitlements.plist"));
    }
    signingArgs.push(join(staging, `${helper}.app`));
    execFileSync("codesign", signingArgs, { stdio: "inherit" });
  }
}

// O bundler do Tauri copia os caminhos abaixo para dentro de Contents/Frameworks e assina a árvore inteira.
console.log(`[stage-cef] CEF ${cefArch} e ${helpers.length} helpers preparados para assinatura no bundle macOS`);
