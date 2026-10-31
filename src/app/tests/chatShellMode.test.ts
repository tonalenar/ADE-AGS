import { beforeEach, describe, expect, it } from "vitest";

import { matchShortcut } from "@/app/shortcuts";
import { chatShellOn, useUiStore } from "@/app/uiStore";

describe("modo chat no uiStore", () => {
  beforeEach(() => useUiStore.setState({ chatMode: false, shellMode: "workspace" }));

  it("com o modo desligado, pedir o chat não muda a casca", () => {
    useUiStore.getState().setShellMode("chat");
    expect(useUiStore.getState().shellMode).toBe("workspace");
    expect(chatShellOn(useUiStore.getState())).toBe(false);
  });

  it("ligado, a casca do chat entra e sai", () => {
    useUiStore.getState().setChatMode(true);
    useUiStore.getState().setShellMode("chat");
    expect(chatShellOn(useUiStore.getState())).toBe(true);
    useUiStore.getState().setShellMode("workspace");
    expect(chatShellOn(useUiStore.getState())).toBe(false);
  });

  it("desligar o modo com o chat na tela volta para o workspace", () => {
    useUiStore.getState().setChatMode(true);
    useUiStore.getState().setShellMode("chat");
    useUiStore.getState().setChatMode(false);
    expect(useUiStore.getState().shellMode).toBe("workspace");
  });
});

describe("atalho do modo chat", () => {
  const chord = (patch: Partial<Parameters<typeof matchShortcut>[0]>) =>
    matchShortcut({ key: "L", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...patch });

  it("Ctrl+Shift+L alterna o chat", () => {
    expect(chord({})?.action).toEqual({ kind: "toggleChat" });
  });

  it("com Alt (AltGr) não dispara", () => {
    expect(chord({ altKey: true })).toBeNull();
  });
});
