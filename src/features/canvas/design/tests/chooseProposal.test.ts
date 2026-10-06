import { describe, expect, it } from "vitest";
import { CHOOSE_DEDUPE_MS, claimChoice, releaseChoice } from "../chooseProposal";

describe("claimChoice", () => {
  it("a mesma escolha só passa uma vez na janela", () => {
    expect(claimChoice("b1|#B", 1000)).toBe(true);
    expect(claimChoice("b1|#B", 1500)).toBe(false);
    expect(claimChoice("b1|#C", 1500)).toBe(true);
  });
  it("depois da janela, ou liberada após falha, passa de novo", () => {
    claimChoice("b2|#A", 1000);
    expect(claimChoice("b2|#A", 1000 + CHOOSE_DEDUPE_MS + 1)).toBe(true);
    releaseChoice("b2|#A");
    expect(claimChoice("b2|#A", 1000 + CHOOSE_DEDUPE_MS + 2)).toBe(true);
  });
});
