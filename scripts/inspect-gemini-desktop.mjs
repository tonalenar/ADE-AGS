// Read only: inspect installed application code, never its user profile or cookies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Gemini");
if (!root || !fs.existsSync(root)) throw new Error("Gemini Desktop installation not found.");
const versions = fs.readdirSync(root)
  .filter((name) => /^app-\d+\.\d+\.\d+$/.test(name))
  .sort((a, b) => b.slice(4).localeCompare(a.slice(4), undefined, { numeric: true }));
const install = versions.map((name) => path.join(root, name))
  .find((dir) => fs.existsSync(path.join(dir, "resources", "app.asar")));
if (!install) throw new Error("No version with resources/app.asar was found.");
const archive = path.join(install, "resources", "app.asar");
const bytes = fs.readFileSync(archive);
if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error("Invalid ASAR header.");
const headerSize = bytes.readUInt32LE(4);
const jsonSize = bytes.readUInt32LE(12);
const dataStart = 8 + headerSize;
if (16 + jsonSize > dataStart || dataStart > bytes.length) throw new Error("Invalid ASAR sizes.");
const tree = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString("utf8"));
function read(name) {
  let entry = tree;
  for (const part of name.split("/")) entry = entry.files?.[part];
  if (!entry || entry.files || entry.link) throw new Error(`Unsupported ASAR entry: ${name}`);
  if (entry.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, name), "utf8");
  const start = dataStart + Number(entry.offset);
  const end = start + entry.size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < dataStart || end > bytes.length) {
    throw new Error(`Invalid ASAR entry bounds: ${name}`);
  }
  return bytes.subarray(start, end).toString("utf8");
}
const pkg = JSON.parse(read("package.json"));
const main = read(pkg.main);
const preload = read("src/preload.js");
const debugSwitches = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "proxy-server", "disable-web-security"];
const report = {
  inspectedAt: new Date().toISOString(),
  install,
  version: pkg.version,
  declaredAuthor: pkg.author,
  declaredElectronDependency: pkg.devDependencies?.electron,
  // The running executable can use a newer Electron than this package declaration.
  mainEntry: pkg.main,
  archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  observations: {
    loadsGeminiWebApp: main.includes("https://gemini.google.com/app"),
    usesWebContentsView: main.includes("WebContentsView"),
    usesNativeAddon: main.includes("gemini_native.node"),
    usesSingleInstanceLock: main.includes("requestSingleInstanceLock"),
    hasDebugSwitchRejectionMessage: main.includes("refusing to start"),
    debugSwitchNamesPresent: debugSwitches.filter((name) => main.includes(name)),
    usesNamedPipeHelper: main.includes("createConnection") && main.includes("HELLO"),
    preloadExposesGeminiNative: preload.includes('exposeInMainWorld("geminiNative"'),
    // These checks identify evidence, not a promise of a supported public API.
    hasDefaultProtocolRegistration: main.includes("setAsDefaultProtocolClient"),
    hasHttpServerCreation: /\bcreateServer\s*\(/.test(main),
  },
  scope: "Installed application resources only; no credentials, user profile, network requests, or writes to the installation.",
};
console.log(JSON.stringify(report, null, 2));
