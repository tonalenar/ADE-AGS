/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTeamMessages } from "../TeamFeed";
import type { TeamMessage } from "../teamFeedModel";

const { invoke, handlers } = vi.hoisted(() => ({ invoke: vi.fn(), handlers: [] as (() => void)[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_: string, cb: () => void) => { handlers.push(cb); return Promise.resolve(() => {}); },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const msg = (id: number): TeamMessage => ({ id, missionId: "m", atMs: id, kind: "tell", fromTabId: "a", fromName: "A", toTabId: "b", toName: "B", text: `m${id}` });

let host: HTMLDivElement;
let root: Root;
let seen: TeamMessage[] = [];
function Probe() { seen = useTeamMessages("m"); return null; }
beforeEach(() => { vi.useFakeTimers(); invoke.mockReset(); handlers.length = 0; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("useTeamMessages", () => {
  it("duas leituras ao mesmo tempo não repetem mensagens: uma em voo, a outra reexecuta com o último id", async () => {
    const resolvers: ((rows: TeamMessage[]) => void)[] = [];
    invoke.mockImplementation(() => new Promise<TeamMessage[]>((res) => { resolvers.push(res); }));
    await act(async () => { root.render(<Probe />); });
    expect(invoke).toHaveBeenCalledTimes(1);
    // chega um evento e o poll de 5 s enquanto a primeira leitura ainda não voltou
    await act(async () => { handlers[0](); vi.advanceTimersByTime(5000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { resolvers[0]([msg(1), msg(2)]); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("mission_messages", { missionId: "m", afterId: 2 });
    // mesmo que o backend repita linhas, o feed não duplica
    await act(async () => { resolvers[1]([msg(2), msg(3)]); });
    expect(seen.map((m) => m.id)).toEqual([1, 2, 3]);
  });
});
