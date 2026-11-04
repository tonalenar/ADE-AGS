import { describe, expect, it } from "vitest";

import { CHAT_POOL_MODES, parseChatPoolMode } from "@/features/accounts/chatPool";

describe("modo do pool de contas no chat", () => {
  it("o padrão e qualquer valor desconhecido são «desligado»", () => {
    expect(parseChatPoolMode(null)).toBe("off");
    expect(parseChatPoolMode(undefined)).toBe("off");
    expect(parseChatPoolMode("")).toBe("off");
    expect(parseChatPoolMode("sim")).toBe("off");
  });

  it("só «ask» e «auto» ligam", () => {
    expect(parseChatPoolMode("ask")).toBe("ask");
    expect(parseChatPoolMode("auto")).toBe("auto");
    expect(CHAT_POOL_MODES).toEqual(["off", "ask", "auto"]);
  });
});
