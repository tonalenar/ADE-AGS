import { describe, expect, it } from "vitest";

import { cloneDialogError } from "../cloneDialogError";

describe("cloneDialogError", () => {
  it("usa a mensagem do ForgeError, não [object Object]", () => {
    expect(cloneDialogError({ kind: "api", message: "sem conta neste host" })).toBe("sem conta neste host");
  });
});
