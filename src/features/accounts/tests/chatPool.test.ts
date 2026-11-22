import { describe, expect, it } from "vitest";

import { CHAT_POOL_MODES, parseChatPoolMode } from "@/features/accounts/chatPool";

describe("modo unificado do pool de contas (conversas e tarefas)", () => {
  it("sem valor salvo o padrão é «ask» (Perguntar); valor desconhecido falha fechado em «off»", () => {
    expect(parseChatPoolMode(null)).toBe("ask");
    expect(parseChatPoolMode(undefined)).toBe("ask");
    expect(parseChatPoolMode("")).toBe("ask");
    expect(parseChatPoolMode("sim")).toBe("off");
  });

  it("respeita os valores salvos «off», «ask» e «auto»", () => {
    expect(parseChatPoolMode("off")).toBe("off");
    expect(parseChatPoolMode("ask")).toBe("ask");
    expect(parseChatPoolMode("auto")).toBe("auto");
    expect(CHAT_POOL_MODES).toEqual(["off", "ask", "auto"]);
  });
});
