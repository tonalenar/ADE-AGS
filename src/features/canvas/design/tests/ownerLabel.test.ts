import { describe, expect, it } from "vitest";
import { ownerProblem } from "../ownerLabel";

describe("ownerProblem", () => {
  it("com aba resolvida não há problema", () => expect(ownerProblem({ ownerWarning: "closed" }, true)).toBeNull());
  it("usa o aviso do backend", () => {
    expect(ownerProblem({ ownerWarning: "closed" }, false)).toBe("closed");
    expect(ownerProblem({ ownerWarning: "missing" }, false)).toBe("missing");
  });
  it("sem informação do backend, sem dono", () => expect(ownerProblem({}, false)).toBe("missing"));
});
