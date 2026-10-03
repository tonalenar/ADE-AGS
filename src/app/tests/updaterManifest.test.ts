import { describe, expect, it } from "vitest";

import { platformsFor } from "../../../scripts/updater-manifest.mjs";

// Los nombres reales de los instaladores de la v1.7.3, más lo que agrega la firma.
const FILES = [
  "ade-ags-1.7.4-1.x86_64.rpm", "ade-ags-1.7.4-1.x86_64.rpm.sig",
  "ade-ags-1.7.4-1.aarch64.rpm", "ade-ags-1.7.4-1.aarch64.rpm.sig",
  "ags_1.7.4_amd64.deb", "ags_1.7.4_amd64.deb.sig",
  "ags_1.7.4_amd64.AppImage", "ags_1.7.4_amd64.AppImage.sig",
  "ags_1.7.4_x64-setup.exe", "ags_1.7.4_x64-setup.exe.sig",
  "ags_1.7.4_x64_en-US.msi", "ags_1.7.4_x64_en-US.msi.sig",
  "ags_1.7.4_aarch64.app.tar.gz", "ags_1.7.4_aarch64.app.tar.gz.sig",
  // Sin firma: no puede ofrecerse para actualizar.
  "ags_1.7.4_arm64.deb",
  "ags_1.7.4_aarch64.dmg",
];

describe("platformsFor", () => {
  const platforms = platformsFor(FILES, "https://gh/r/releases/download/v1.7.4", (f) => `sig-of-${f}\n`);

  it("cada instalación se actualiza con su mismo formato", () => {
    expect(platforms["linux-x86_64-rpm"].url).toBe("https://gh/r/releases/download/v1.7.4/ade-ags-1.7.4-1.x86_64.rpm");
    expect(platforms["linux-aarch64-rpm"].signature).toBe("sig-of-ade-ags-1.7.4-1.aarch64.rpm.sig");
    expect(platforms["linux-x86_64-deb"]).toBeDefined();
    expect(platforms["windows-x86_64-nsis"].url).toContain("x64-setup.exe");
    expect(platforms["windows-x86_64-msi"].url).toContain(".msi");
    expect(platforms["darwin-aarch64-app"].url).toContain("aarch64.app.tar.gz");
  });

  it("sin formato queda el de siempre de cada sistema (AppImage, NSIS, .app)", () => {
    expect(platforms["linux-x86_64"].url).toContain(".AppImage");
    expect(platforms["windows-x86_64"].url).toContain("setup.exe");
    expect(platforms["darwin-aarch64"].url).toContain(".app.tar.gz");
  });

  it("lo que no está firmado no se ofrece", () => {
    expect(platforms["linux-aarch64-deb"]).toBeUndefined();
    expect(Object.values(platforms).some((p) => p.url.endsWith(".dmg"))).toBe(false);
  });
});
