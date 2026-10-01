import { describe, expect, it } from "vitest";
import { leadUnsupported, providerDisabled } from "../leadProviders";
import type { RosterAgent } from "../types";
const provider = (id: string, orchestration: boolean): RosterAgent => ({
  agentId: id, label: id, installed: true, launchable: true, unavailable: null,
  capabilities: { headless: true, mcp: orchestration, orchestration },
  models: [], accounts: [], modelDiscovery: "unavailable",
});
describe("Lead capabilities", () => {
  it("keeps Codex visible, disabled only as Lead", () => {
    const codex = provider("codex", false);
    expect(providerDisabled(codex, true)).toBe(true);
    expect(leadUnsupported(codex)).toBe(true);
    expect(providerDisabled(codex, false)).toBe(false);
  });
  it("permits implemented orchestration providers", () => {
    for (const id of ["opencode", "claude-code"]) expect(providerDisabled(provider(id, true), true)).toBe(false);
  });
  it("uses capability for future providers", () => {
    expect(providerDisabled(provider("future-provider", true), true)).toBe(false);
    expect(leadUnsupported(provider("historical-provider", false))).toBe(true);
  });
});
