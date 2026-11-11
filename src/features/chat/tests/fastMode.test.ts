// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("../harnessCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harnessCapabilities")>();
  return {
    ...actual,
    readHarnessCapability: (surface: string, provider: string, capability: string) =>
      surface === "chat" && (provider === "codex" || provider === "claude-code") && capability === "fast_mode"
        ? { support: "supported", available: true, reason: null, loading: false }
        : actual.readHarnessCapability(surface as never, provider, capability),
  };
});

import { DEFAULT_CHAT_PREFS, saveChatPrefs } from "../chatPrefs";
import { saveChatProjectField } from "../chatProjectPrefs";
import { fastModeForThread } from "../fastMode";
import { chatThreadSend } from "../structured/ipc";

beforeEach(() => {
  localStorage.clear();
  saveChatPrefs({ ...DEFAULT_CHAT_PREFS, fastMode: true });
  tauri.invoke.mockClear();
});

describe("Fast no chat estruturado", () => {
  it("herda a preferência da máquina e respeita o padrão explícito do projeto", () => {
    expect(fastModeForThread({ agentId: "codex", cwd: "/p" })).toBe(true);
    expect(fastModeForThread({ agentId: "claude-code", cwd: "/p" })).toBe(true);
    expect(saveChatProjectField("/p", "fastMode", false)).toBe(true);
    expect(fastModeForThread({ agentId: "codex", cwd: "/p" })).toBe(false);
    expect(fastModeForThread({ agentId: "opencode", cwd: "/p" })).toBe(false);
  });

  it("envia a escolha Fast junto com o turno IPC", () => {
    void chatThreadSend("t1", "oi", ["/p/img.png"], true);
    expect(tauri.invoke).toHaveBeenCalledWith("chat_thread_send", {
      threadId: "t1", text: "oi", images: ["/p/img.png"], fastMode: true,
    });
  });
});
