import { describe, expect, it } from "vitest";

import { accountConnectOffer, accountFormMode, programPresent } from "../accountConnect";

describe("accountConnectOffer", () => {
  it("deixa ligar o Claude por API key mesmo sem o programa", () => {
    expect(accountConnectOffer("claude-code", false)).toEqual({ kind: "api-key", login: false });
    expect(accountFormMode("claude-code", false)).toBe("api-key");
  });

  it("oferece login e API key quando o Claude ou o Codex estão na máquina", () => {
    expect(accountConnectOffer("claude-code", true)).toEqual({ kind: "api-key", login: true });
    expect(accountFormMode("claude-code", true)).toBe("both");
    expect(accountConnectOffer("codex", true)).toEqual({ kind: "dialog" });
    expect(accountFormMode("codex", true)).toBe("both");
  });

  it("não abre o login do Codex nem do OpenCode sem o programa", () => {
    expect(accountConnectOffer("codex", false)).toEqual({ kind: "program" });
    expect(accountFormMode("codex", false)).toBe("blocked");
    expect(accountConnectOffer("opencode", false)).toEqual({ kind: "program" });
    expect(accountFormMode("opencode", true)).toBe("login");
  });

  it("pede o login do Cursor Agent quando o programa está na máquina", () => {
    expect(accountConnectOffer("cursor", true)).toEqual({ kind: "cli-login" });
    expect(accountFormMode("cursor", true)).toBe("blocked");
    expect(accountConnectOffer("cursor", false)).toEqual({ kind: "program" });
  });

  it("aceita o programa quando a lista já o viu e o cadastro ainda não", () => {
    expect(programPresent(false, true)).toBe(true);
    expect(accountFormMode("codex", programPresent(false, true))).toBe("both");
    expect(programPresent(false, false)).toBe(false);
  });

  it("leva o Antigravity ao OAuth do app e os demais ao aviso do programa", () => {
    expect(accountConnectOffer("antigravity", false)).toEqual({ kind: "oauth" });
    expect(accountConnectOffer("gemini-cli", false)).toEqual({ kind: "program" });
    expect(accountConnectOffer("gemini-cli", true)).toEqual({ kind: "found" });
    expect(accountConnectOffer("kimi-code", true)).toEqual({ kind: "found" });
    expect(accountConnectOffer("hermes", false)).toEqual({ kind: "program" });
  });
});
