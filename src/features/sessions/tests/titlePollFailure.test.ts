import { describe, expect, it } from "vitest";

import { noteTitlePollFailure } from "../titlePollFailure";

describe("noteTitlePollFailure", () => {
  it("só pede aviso visível na segunda falha seguida", () => {
    expect(noteTitlePollFailure(0)).toEqual({ consecutive: 1, notify: false });
    expect(noteTitlePollFailure(1)).toEqual({ consecutive: 2, notify: true });
  });
});
