import { describe, expect, it } from "vitest";

import { uiErrorText } from "../uiErrorText";

describe("uiErrorText", () => {
  it("não vira [object Object]", () => {
    expect(uiErrorText({ message: "sem conta neste host" })).toBe("sem conta neste host");
    expect(uiErrorText(new Error("ipc"))).toBe("ipc");
    expect(uiErrorText("texto")).toBe("texto");
  });

  it("objeto sem message vira kind ou JSON curto", () => {
    expect(uiErrorText({ kind: "ipc" })).toBe("ipc");
    expect(uiErrorText({ code: 7, path: "/tmp" })).toBe('{"code":7,"path":"/tmp"}');
    expect(uiErrorText({ kind: "ipc" })).not.toBe("[object Object]");
    expect(uiErrorText({ code: 7 })).not.toBe("[object Object]");
  });
});
