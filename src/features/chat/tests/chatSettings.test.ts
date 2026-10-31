import { describe, expect, it } from "vitest";

import { startShell } from "@/app/uiStore";
import { CHAT_SETTINGS_GROUPS, settingsLabelKey } from "@/features/chat/chatSettingsNav";
import { parseChatPrefs } from "@/features/chat/chatPrefs";
import { SETTINGS_NAV } from "@/features/settings/settingsNav";

describe("modo inicial", () => {
  it("sem escolha, abre onde estava", () => {
    expect(startShell(true, "chat", null)).toBe("chat");
    expect(startShell(true, "workspace", null)).toBe("workspace");
  });

  it("a escolha vence o lembrado; Abas e Canvas são o workspace", () => {
    expect(startShell(true, "workspace", "chat")).toBe("chat");
    expect(startShell(true, "chat", "tabs")).toBe("workspace");
    expect(startShell(true, "chat", "canvas")).toBe("workspace");
  });

  it("com o modo chat desligado, sempre o workspace", () => {
    expect(startShell(false, "chat", "chat")).toBe("workspace");
  });
});

describe("largura da conversa", () => {
  it("normal por padrão; só aceita os três valores", () => {
    expect(parseChatPrefs({}).width).toBe("normal");
    expect(parseChatPrefs({ width: "wide" }).width).toBe("wide");
    expect(parseChatPrefs({ width: "full" }).width).toBe("full");
    expect(parseChatPrefs({ width: "gigante" }).width).toBe("normal");
  });
});

describe("menu das Configurações no chat", () => {
  it("tem todas as seções da página, cada uma uma vez", () => {
    const chat = CHAT_SETTINGS_GROUPS.flatMap((g) => g.items);
    expect(new Set(chat).size).toBe(chat.length);
    expect([...chat].sort()).toEqual(SETTINGS_NAV.flat().sort());
  });

  it("o nome vem das chaves da página", () => {
    expect(settingsLabelKey("chat")).toBe("settings.chat");
  });
});
