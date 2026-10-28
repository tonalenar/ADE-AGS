import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { useTabsStore } from "@/features/tabs/store";

import { addEdge, emptyBoard, setRole, toggleOrchestrator, type Board } from "../board";
import { initOrchestratorAnnouncements } from "../orchestratorAnnounce";
import { forgetOrchestrator } from "../orchestratorNotice";
import { useCanvasStore } from "../store";

vi.mock("@/features/terminal/terminalRegistry", () => ({ sendWhenReady: vi.fn() }));
const send = vi.mocked(sendWhenReady);

const tab = (id: string, title: string) => ({ id, title, agentId: "claude-code", agentLabel: "Claude Code", cwd: "/p" });

function team(): Board {
  let board: Board = { ...emptyBoard(), nodes: { orq: { x: 0, y: 0, w: 10, h: 10 }, sub: { x: 20, y: 0, w: 10, h: 10 } } };
  board = toggleOrchestrator(board, "orq");
  board = addEdge(board, "orq", "sub");
  return setRole(board, "sub", null, true);
}

/** O time de um orquestrador montado SEM o mouse (recrutado pelo `ags`, conversa reaberta) também o avisa. */
describe("aviso automático ao orquestrador", () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    forgetOrchestrator("orq");
    useTabsStore.setState({ tabs: [tab("orq", "Orquestrador"), tab("sub", "OpenCode")] as never, hydrated: true });
    useCanvasStore.setState({ boards: {}, loaded: true });
    stop = initOrchestratorAnnouncements();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("um time que aparece no canvas avisa o orquestrador uma vez", () => {
    useCanvasStore.setState({ boards: { "main|/p#c:1": team() } });
    vi.advanceTimersByTime(700);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("orq");
    expect(send.mock.calls[0][1]).toContain("Você é o orquestrador");

    // Outra mudança qualquer no canvas, com o mesmo time: nada de novo.
    useCanvasStore.setState({ boards: { "main|/p#c:1": { ...team(), viewport: { x: 5, y: 5, zoom: 1 } } } });
    vi.advanceTimersByTime(700);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("missões ficam de fora: o líder recebe o próprio briefing", () => {
    useCanvasStore.setState({ boards: { "main|/p#m:abc": team() } });
    vi.advanceTimersByTime(700);
    expect(send).not.toHaveBeenCalled();
  });

  it("antes de o canvas salvo carregar, não avisa ninguém (o time ainda está no disco)", () => {
    useCanvasStore.setState({ loaded: false, boards: { "main|/p#c:1": team() } });
    vi.advanceTimersByTime(700);
    expect(send).not.toHaveBeenCalled();
  });

  it("antes de as abas restaurarem, não avisa ninguém", () => {
    useTabsStore.setState({ hydrated: false });
    useCanvasStore.setState({ boards: { "main|/p#c:1": team() } });
    vi.advanceTimersByTime(700);
    expect(send).not.toHaveBeenCalled();
  });
});
