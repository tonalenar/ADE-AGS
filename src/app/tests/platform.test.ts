import { describe, expect, it } from "vitest";

import { osFromUserAgent } from "@/app/platform";

describe("o sistema pelo user agent (botões da janela de cada um)", () => {
  it("macOS, Windows e Linux", () => {
    expect(osFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("macos");
    expect(osFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0")).toBe("windows");
    expect(osFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });
});
