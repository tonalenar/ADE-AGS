/** Prepara um bundle CEF debug para o macOS sem abrir a interface. */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (platform !== "darwin") process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const targetDir = join(tauriDir, "target", "debug");
const appPath = join(targetDir, "ADE AGS.app");
const contents = join(appPath, "Contents");
const frameworks = join(contents, "Frameworks");
const cefArch = arch === "arm64" ? "aarch64" : "x86_64";
const helpers = ["ADE AGS Helper", "ADE AGS Helper (GPU)", "ADE AGS Helper (Renderer)", "ADE AGS Helper (Plugin)", "ADE AGS Helper (Alerts)"];

execFileSync("cargo", ["build", "--no-default-features", "--bin", "ade-ags", "--bin", "ade-ags-helper"], {
  cwd: tauriDir,
  stdio: "inherit",
});

const cefBuildRoot = join(targetDir, "build");
const cefBuild = readdirSync(cefBuildRoot)
  .filter((name) => name.startsWith("cef-dll-sys-"))
  .map((name) => join(cefBuildRoot, name, "out", `cef_macos_${cefArch}`))
  .find((path) => {
    try { return readdirSync(path).includes("Chromium Embedded Framework.framework"); } catch { return false; }
  });
if (!cefBuild) throw new Error(`Não achei a distribuição CEF macOS ${cefArch} em ${cefBuildRoot}.`);

rmSync(appPath, { recursive: true, force: true });
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(contents, "Resources"), { recursive: true });
mkdirSync(frameworks, { recursive: true });
symlinkSync(join(targetDir, "ade-ags"), join(contents, "MacOS", "ade-ags"), "file");
symlinkSync(join(cefBuild, "Chromium Embedded Framework.framework"), join(frameworks, "Chromium Embedded Framework.framework"), "dir");

const appPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>ade-ags</string>
<key>CFBundleIdentifier</key><string>com.luis.controlcode.debug</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>ADE AGS</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.14.0</string>
<key>CFBundleVersion</key><string>1.14.0</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>`;
writeFileSync(join(contents, "Info.plist"), appPlist);

for (const [index, helper] of helpers.entries()) {
  const helperContents = join(frameworks, `${helper}.app`, "Contents");
  const macos = join(helperContents, "MacOS");
  mkdirSync(macos, { recursive: true });
  const executable = join(macos, helper);
  copyFileSync(join(targetDir, "ade-ags-helper"), executable);
  chmodSync(executable, 0o755);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>${helper}</string>
<key>CFBundleIdentifier</key><string>com.luis.controlcode.debug.helper.${index}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>${helper}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.14.0</string>
<key>CFBundleVersion</key><string>1.14.0</string>
<key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>`;
  writeFileSync(join(helperContents, "Info.plist"), plist);
}

console.log(`[stage-cef-dev] bundle temporário e ${helpers.length} helpers prontos em ${appPath}`);
