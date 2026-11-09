// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CHAT_PREFS } from "../chatPrefs";
import {
  clearChatProjectDefaults,
  loadChatProjectDefaults,
  normalizeProjectPath,
  parseChatProjectDefaults,
  saveChatProjectDefaults,
} from "../chatProjectPrefs";

const STORAGE_KEY = "cc-chat-project-defaults";
const OVERRIDES_KEY = "cc-chat-project-overrides-v1";

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(OVERRIDES_KEY);
});

describe("padrões locais de conversa por projeto", () => {
  it("normaliza separadores e barras finais sem fundir projetos diferentes", () => {
    expect(normalizeProjectPath("C:\\work\\repo\\")).toBe("C:/work/repo");
    expect(normalizeProjectPath("/work/repo///")).toBe("/work/repo");
    expect(normalizeProjectPath("/")).toBe("/");
    expect(normalizeProjectPath("/work/Repo")).not.toBe(normalizeProjectPath("/work/repo"));
  });

  it("valida os valores persistidos e usa Auto quando o acesso estiver corrompido", () => {
    expect(parseChatProjectDefaults({
      agentId: "codex", model: "gpt-6", effort: "high", access: "full", plan: true,
      fastMode: true, worktree: true, structured: false, accountId: "não persistir",
    })).toEqual({
      agentId: "codex", model: "gpt-6", effort: "high", access: "full", plan: true,
      fastMode: true, worktree: true, structured: false,
    });
    expect(parseChatProjectDefaults({ access: "admin" })?.access).toBe("safe");
    expect(parseChatProjectDefaults("lixo")).toBeNull();
  });

  it("salva e reaplica as escolhas sem guardar a conta ou a largura global", () => {
    const prefs = { ...DEFAULT_CHAT_PREFS, agentId: "codex", model: "gpt-6", effort: "high", access: "full" as const, accountId: "conta-local", width: "wide" as const };
    saveChatProjectDefaults("/work/repo/", prefs);

    expect(loadChatProjectDefaults("/work/repo")).toEqual({
      agentId: "codex", model: "gpt-6", effort: "high", access: "full", plan: false,
      fastMode: false, worktree: false, structured: true,
    });
    const raw = localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).not.toContain("conta-local");
    expect(raw).not.toContain("width");
  });

  it("remove os padrões de um projeto e preserva os dos demais", () => {
    saveChatProjectDefaults("/work/a", { ...DEFAULT_CHAT_PREFS, agentId: "codex" });
    saveChatProjectDefaults("/work/b", { ...DEFAULT_CHAT_PREFS, agentId: "claude-code" });
    clearChatProjectDefaults("/work/a/");

    expect(loadChatProjectDefaults("/work/a")).toBeNull();
    expect(loadChatProjectDefaults("/work/b")?.agentId).toBe("claude-code");
  });
});
