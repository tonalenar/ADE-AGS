import { describe, expect, it } from "vitest";

import { installRowState, type AgentInstallOffer } from "../installPolicy";

const offer = (patch: Partial<AgentInstallOffer>): AgentInstallOffer => ({
  agentId: "codex",
  canInstall: false,
  needsRuntime: false,
  manual: null,
  ...patch,
});

describe("installRowState", () => {
  it("não oferece instalação para quem já está na máquina", () => {
    expect(installRowState(true, offer({ canInstall: true }), false)).toEqual({ kind: "none" });
  });

  it("mostra o botão só quando a ADE conhece o pacote", () => {
    expect(installRowState(false, offer({ canInstall: true }), false)).toEqual({ kind: "button", enabled: true });
    expect(installRowState(false, offer({ canInstall: true }), true)).toEqual({ kind: "button", enabled: false });
  });

  it("mostra o comando manual, o runtime ou o aplicativo", () => {
    expect(installRowState(false, offer({ manual: "npm install -g @opencode/cli" }), false)).toEqual({
      kind: "manual",
      command: "npm install -g @opencode/cli",
    });
    expect(installRowState(false, offer({ needsRuntime: true }), false)).toEqual({ kind: "runtime" });
    expect(installRowState(false, offer({}), false)).toEqual({ kind: "app" });
    expect(installRowState(false, undefined, false)).toEqual({ kind: "none" });
  });
});
