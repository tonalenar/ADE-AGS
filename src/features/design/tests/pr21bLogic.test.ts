import { describe, expect, it } from "vitest";

import { clearAgentFlashIds, mergeAgentFlash } from "../agentFlash";
import { shouldSendCommentToAgent } from "../commentSubmit";
import { iframeSrcIdentity } from "../iframeSrc";
import { parseFloatDraft } from "../tweakInput";

describe("A493 float draft", () => {
  it("mantém o ponto decimal no rascunho", () => {
    expect(parseFloatDraft("0.")).toEqual({ kind: "draft" });
    expect(parseFloatDraft("0.5")).toEqual({ kind: "number", value: 0.5 });
    expect(parseFloatDraft(".")).toEqual({ kind: "draft" });
  });
});

describe("A492 comentário", () => {
  it("não manda ao agente se a gravação falhou", () => {
    expect(shouldSendCommentToAgent(null, true)).toBe(false);
    expect(shouldSendCommentToAgent({ id: "c1" }, true)).toBe(true);
    expect(shouldSendCommentToAgent({ id: "c1" }, false)).toBe(false);
  });
});

describe("A494 iframe", () => {
  it("a identidade do srcDoc não inclui o HTML", () => {
    expect(iframeSrcIdentity("b1", true)).toBe("live:b1");
    expect(iframeSrcIdentity("b1", true)).toBe(iframeSrcIdentity("b1", true));
  });
});

describe("A491 flash", () => {
  it("um reload não apaga o flash da prancheta anterior", () => {
    const first = mergeAgentFlash({}, ["a"]);
    const second = mergeAgentFlash(first, ["b"]);
    expect(second).toEqual({ a: true, b: true });
    expect(clearAgentFlashIds(second, ["a"])).toEqual({ b: true });
  });
});
