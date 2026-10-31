import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("../ChatShell.tsx", import.meta.url), "utf-8");
const switcher = readFileSync(new URL("../ShellModeSwitch.tsx", import.meta.url), "utf-8");

describe("o cabeçalho do modo chat não tem colisão", () => {
  it("o seletor Chat | Abas | Canvas está SEMPRE no cabeçalho principal e nunca encolhe (o breadcrumb é que cede)", () => {
    expect(shell).toMatch(/<ShellModeSwitch className="shrink-0" \/>/);
    expect(shell).not.toMatch(/\{!sidebarOpen && <ShellModeSwitch/);
  });
  it("a barra lateral não leva o seletor (ele não cabe nos 256 px e vazava sobre o breadcrumb)", () => {
    expect(shell).not.toMatch(/modeSwitch=/);
  });
  it("o breadcrumb trunca: flex-1 min-w-0 truncate", () => {
    expect(shell).toMatch(/flex-1 min-w-0 flex items-center gap-3 truncate/);
  });
  it("o seletor mantém a opção Canvas e aceita className", () => {
    expect(switcher).toContain("canvasKeyFor");
    expect(switcher).toMatch(/className = ""/);
  });
});

describe("há UM seletor Chat | Abas | Canvas por modo, e os botões nunca viram região de arrasto", () => {
  it("o seletor do chat só é montado no ChatShell (o TabBar só tem o ModeToggle das Abas/Canvas, escondido no chat)", () => {
    const bar = readFileSync(new URL("../../tabs/TabBar.tsx", import.meta.url), "utf-8");
    expect(bar).not.toMatch(/<ShellModeSwitch/);
    expect((shell.match(/<ShellModeSwitch/g) ?? []).length).toBe(1);
  });
  it("cada botão do seletor tem data-tauri-drag-region=false", () => {
    expect(switcher).toMatch(/<button key=\{option.value\}[^>]*data-tauri-drag-region="false"/);
  });
});
