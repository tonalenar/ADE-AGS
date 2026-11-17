import { describe, expect, it } from "vitest";

import { uiErrorText } from "../uiErrorText";

describe("uiErrorText", () => {
  it("não vira [object Object]", () => {
    expect(uiErrorText({ message: "sem conta neste host" })).toBe("sem conta neste host");
    expect(uiErrorText(new Error("ipc"))).toBe("ipc");
    expect(uiErrorText("texto")).toBe("texto");
  });
});
