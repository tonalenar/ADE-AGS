import { afterEach, describe, expect, it, vi } from "vitest";

const tabs = vi.hoisted(() => ({ list: [] as Array<{ id: string; ptyId: number | null }> }));

vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ tabs: tabs.list }) } }));
vi.mock("../ptyLaunch", () => ({ requestPtyLaunch: vi.fn() }));

import { onPromptSubmitted, pasteIntoTab, recentPaste, registerTerminal } from "../terminalRegistry";

/** O mínimo do xterm: a linha do cursor e quem escuta o `onData`. */
function fakeTerm(line: string) {
  let onData: ((data: string) => void) | null = null;
  const term = {
    modes: { bracketedPasteMode: true },
    paste: () => undefined,
    input: (data: string) => onData?.(data),
    onData: (fn: (data: string) => void) => { onData = fn; return { dispose: () => { onData = null; } }; },
    onWriteParsed: () => ({ dispose: () => undefined }),
    buffer: {
      active: {
        baseY: 0, cursorY: 0, cursorX: line.length,
        getLine: (y: number) => (y === 0 ? { translateToString: () => line } : undefined),
      },
    },
  };
  return { term: term as unknown as import("@xterm/xterm").Terminal, type: (data: string) => onData?.(data) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  tabs.list = [];
  vi.useRealTimers();
});

describe("Enter num terminal", () => {
  it("avisa quem escuta com o texto da caixa de entrada", () => {
    tabs.list = [{ id: "a", ptyId: 1 }];
    const fake = fakeTerm("│ > corrige o login");
    cleanups.push(registerTerminal("a", fake.term));
    const seen: Array<[string, string]> = [];
    cleanups.push(onPromptSubmitted((tabId, _at, typed) => { seen.push([tabId, typed]); }));
    fake.type("x");
    fake.type("\r");
    expect(seen).toEqual([["a", "│ > corrige o login"]]);
  });

  it("lembra por uns segundos o que o app colou com Enter", () => {
    vi.useFakeTimers();
    tabs.list = [{ id: "b", ptyId: 1 }];
    const fake = fakeTerm("");
    cleanups.push(registerTerminal("b", fake.term));
    expect(pasteIntoTab("b", "briefing", true)).toBe(true);
    const now = Date.now();
    expect(recentPaste("b", now)).toBe("briefing");
    expect(recentPaste("b", now + 10_000)).toBeNull();
    expect(recentPaste("outra", now)).toBeNull();
    vi.clearAllTimers();
  });
});
