import { describe, expect, it } from "vitest";

import { scmHeadline } from "../headline";

describe("scmHeadline", () => {
  it("mostra a branch de um repo que ainda não tem commit", () => {
    expect(scmHeadline({ branch: "main", head: null, initial: true })).toEqual({
      kind: "initial",
      branch: "main",
    });
  });

  it("mantém a branch quando já existe commit", () => {
    expect(scmHeadline({ branch: "feat/x", head: "abc1234", initial: false })).toEqual({
      kind: "branch",
      branch: "feat/x",
    });
  });

  it("distingue HEAD solto de um repo vazio sem nome de branch", () => {
    expect(scmHeadline({ branch: null, head: "abc1234", initial: false })).toEqual({
      kind: "detached",
      head: "abc1234",
    });
    expect(scmHeadline({ branch: null, head: null, initial: true })).toEqual({
      kind: "initial",
      branch: null,
    });
  });
});
