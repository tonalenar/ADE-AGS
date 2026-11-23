import { describe, expect, it } from "vitest";

import { nextScmPollMs, SCM_POLL_BASE_MS, SCM_POLL_MAX_MS } from "../pollBackoff";

describe("backoff do polling do SCM sob carga", () => {
  it("mantém 4 s quando o git responde rápido e sem erro", () => {
    expect(nextScmPollMs({ elapsedMs: 80, failed: false, streak: 0 })).toBe(SCM_POLL_BASE_MS);
    expect(nextScmPollMs({ elapsedMs: 1499, failed: false, streak: 0 })).toBe(SCM_POLL_BASE_MS);
  });

  it("aumenta o intervalo exponencialmente quando o git demora ou falha", () => {
    expect(nextScmPollMs({ elapsedMs: 1500, failed: false, streak: 1 })).toBe(8000);
    expect(nextScmPollMs({ elapsedMs: 4000, failed: false, streak: 1 })).toBe(12_000);
    expect(nextScmPollMs({ elapsedMs: 200, failed: true, streak: 1 })).toBe(8000);
    expect(nextScmPollMs({ elapsedMs: 200, failed: true, streak: 2 })).toBe(16_000);
    expect(nextScmPollMs({ elapsedMs: 200, failed: true, streak: 3 })).toBe(SCM_POLL_MAX_MS);
    expect(nextScmPollMs({ elapsedMs: 15_000, failed: false, streak: 1 })).toBe(SCM_POLL_MAX_MS);
  });
});
