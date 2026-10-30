import { describe, expect, it } from "vitest";

import { CHAT_SPACES, isSettingsRoute, spaceForPath } from "@/features/chat/chatSpaces";

describe("chatSpaces (as telas cheias no modo chat)", () => {
  it("as subrotas caem no espaço delas", () => {
    expect(spaceForPath("/skills/abc")?.id).toBe("skills");
    expect(spaceForPath("/marketplace/registries")?.id).toBe("marketplace");
    expect(spaceForPath("/missions")?.id).toBe("missions");
  });

  it("um prefixo parecido não conta como o espaço", () => {
    expect(spaceForPath("/skillset")).toBeNull();
  });

  it("as Configurações não são um espaço: têm a sidebar das seções", () => {
    expect(isSettingsRoute("/settings")).toBe(true);
    expect(spaceForPath("/settings")).toBeNull();
    expect(isSettingsRoute("/sessions")).toBe(false);
  });

  it("Memória abre a seção das Configurações", () => {
    const memory = CHAT_SPACES.find((s) => s.id === "memory");
    expect(memory).toMatchObject({ path: "/settings", settingsSection: "memory" });
  });

  it("ids e rotas sem repetição", () => {
    expect(new Set(CHAT_SPACES.map((s) => s.id)).size).toBe(CHAT_SPACES.length);
  });
});
