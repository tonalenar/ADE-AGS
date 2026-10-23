import { afterEach, describe, expect, it, vi } from "vitest";

const tabs = vi.hoisted(() => ({ list: [] as Array<{ id: string; ptyId: number | null }> }));
const launch = vi.hoisted(() => ({ requestPtyLaunch: vi.fn() }));

vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ tabs: tabs.list }) } }));
vi.mock("../ptyLaunch", () => launch);

import { insertIntoTab, registerTerminal } from "../terminalRegistry";

/** O mínimo do xterm que o registro usa para colar. */
function fakeTerm(bracketed: boolean) {
  const pastes: string[] = [];
  const inputs: string[] = [];
  const term = {
    modes: { bracketedPasteMode: bracketed },
    paste: (text: string) => { pastes.push(text); },
    input: (data: string) => { inputs.push(data); },
    onData: () => ({ dispose: () => undefined }),
    onWriteParsed: () => ({ dispose: () => undefined }),
  };
  return { term: term as unknown as import("@xterm/xterm").Terminal, pastes, inputs };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  tabs.list = [];
  launch.requestPtyLaunch.mockReset();
});

describe("insertIntoTab", () => {
  it("cola sem Enter quando a TUI aceita bracketed paste", () => {
    tabs.list = [{ id: "a", ptyId: 1 }];
    const fake = fakeTerm(true);
    cleanups.push(registerTerminal("a", fake.term));
    expect(insertIntoTab("a", "[Trecho]\n```\nx\n```\n")).toBe("ok");
    expect(fake.pastes).toEqual(["[Trecho]\n```\nx\n```\n"]);
    expect(fake.inputs).toEqual([]);
  });

  it("recusa várias linhas sem bracketed paste: cada quebra viraria um Enter", () => {
    tabs.list = [{ id: "a", ptyId: 1 }];
    const fake = fakeTerm(false);
    cleanups.push(registerTerminal("a", fake.term));
    expect(insertIntoTab("a", "uma\nduas")).toBe("no-multiline");
    expect(fake.pastes).toEqual([]);
    expect(insertIntoTab("a", "uma linha")).toBe("ok");
  });

  it("sem terminal viva, avisa e pede o lançamento da aba restaurada", () => {
    expect(insertIntoTab("nada", "x")).toBe("offline");
    tabs.list = [{ id: "b", ptyId: null }];
    const fake = fakeTerm(true);
    cleanups.push(registerTerminal("b", fake.term));
    expect(insertIntoTab("b", "x")).toBe("offline");
    expect(launch.requestPtyLaunch).toHaveBeenCalledWith("b");
    expect(fake.pastes).toEqual([]);
  });
});
