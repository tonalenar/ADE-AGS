import { describe, expect, it } from "vitest";

import { emptyBoard } from "@/features/canvas/board";
import { boardKey, boardKeyOfTab, compareBoardKey, compareOfKey, conversationOfKey, missionOfKey, sessionBoardKey, sessionRefOfKey } from "@/features/canvas/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { useTabsStore } from "@/features/tabs/store";

describe("canvas da comparação", () => {
  it("a chave carrega a comparação e não se confunde com missão nem conversa", () => {
    const key = compareBoardKey("C:/p/app", "abc123");
    expect(compareOfKey(key)).toBe("abc123");
    expect(missionOfKey(key)).toBeNull();
    expect(conversationOfKey(key)).toBeNull();
    expect(compareOfKey(boardKey("C:/p/app"))).toBeNull();
    expect(compareOfKey(null)).toBeNull();
  });

  it("a aba de um worktree pertence ao canvas da comparação em que é nó", () => {
    const key = compareBoardKey("C:/p/app", "abc123");
    const boards = { [key]: { ...emptyBoard(), nodes: { t1: { x: 0, y: 0, w: 10, h: 10 } } } };
    expect(boardKeyOfTab({ id: "t1", cwd: "C:/Users/x/.ags/worktrees/1a2b3c4d" }, boards)).toBe(key);
    expect(boardKeyOfTab({ id: "outra", cwd: "C:/p/app" }, boards)).toBe(sessionBoardKey("C:/p/app", "outra"));
  });

  it("#s: define uma sessão e continua fora dos escopos de missão e conversa de projeto", () => {
    const session = sessionBoardKey("C:/p/app", "thread:abc");
    expect(sessionRefOfKey(session)).toBe("thread:abc");
    expect(missionOfKey(session)).toBeNull();
    expect(conversationOfKey(session)).toBeNull();
  });

  it("uma aba já nó de um canvas #s: fica nele, mesmo que seja a sessão de outra conversa", () => {
    const session = sessionBoardKey("C:/p/app", "thread:abc");
    const boards = { [session]: { ...emptyBoard(), nodes: { worker: { x: 0, y: 0, w: 10, h: 10 } } } };
    expect(boardKeyOfTab({ id: "worker", cwd: "C:/p/app" }, boards)).toBe(session);
  });

  it("duas conversas na mesma pasta ganham canvases próprios", () => {
    const a = boardKeyOfTab({ id: "a", cwd: "C:/p/app" }, {});
    const b = boardKeyOfTab({ id: "b", cwd: "C:/p/app" }, {});
    expect(a).toBe(sessionBoardKey("C:/p/app", "a"));
    expect(b).toBe(sessionBoardKey("C:/p/app", "b"));
    expect(a).not.toBe(b);
  });

  it("conversas ligadas manualmente no canvas da pasta continuam juntas nesse canvas", () => {
    const folder = boardKey("C:/p/app");
    const source = {
      ...emptyBoard(),
      nodes: { a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 20, y: 0, w: 10, h: 10 } },
      edges: [{ id: "e1", a: "a", b: "b" }],
      orchestrators: ["a"],
      roles: { b: "QA" },
      subagents: ["b"],
    };
    useTabsStore.setState({ tabs: [
      { id: "a", cwd: "C:/p/app" } as never,
      { id: "b", cwd: "C:/p/app" } as never,
    ] });
    const boards = { [folder]: source };
    expect(boardKeyOfTab({ id: "a", cwd: "C:/p/app" }, boards)).toBe(folder);
    expect(boardKeyOfTab({ id: "b", cwd: "C:/p/app" }, boards)).toBe(folder);
    expect(source).toMatchObject({ edges: [{ id: "e1", a: "a", b: "b" }], orchestrators: ["a"], roles: { b: "QA" }, subagents: ["b"] });
  });

  it("time promovido do canvas da pasta conserva o grupo e as marcas no mesmo canvas", () => {
    const folder = boardKey("C:/p/app");
    const source = {
      ...emptyBoard(),
      nodes: { lead: { x: 0, y: 0, w: 10, h: 10 }, worker: { x: 20, y: 0, w: 10, h: 10 } },
      edges: [{ id: "e1", a: "lead", b: "worker" }],
      orchestrators: ["lead"],
      roles: { worker: "QA" },
      subagents: ["worker"],
    };
    useTeamIndex.setState({ teams: [{ id: "team", orchestrator: "lead", cwd: "C:/p/app", origin: "canvas", boardKey: folder, members: [{ teamId: "team", member: "worker" }] } as never] });
    useTabsStore.setState({ tabs: [
      { id: "lead", cwd: "C:/p/app" } as never,
      { id: "worker", cwd: "C:/p/app" } as never,
    ] });
    expect(boardKeyOfTab({ id: "lead", cwd: "C:/p/app" }, { [folder]: source })).toBe(folder);
    expect(boardKeyOfTab({ id: "worker", cwd: "C:/p/app" }, { [folder]: source })).toBe(folder);
    expect(source).toMatchObject({ edges: [{ id: "e1", a: "lead", b: "worker" }], orchestrators: ["lead"], roles: { worker: "QA" }, subagents: ["worker"] });
    useTeamIndex.setState({ teams: [] });
  });

  it("integrante de equipe segue o canvas de um orquestrador por protocolo", () => {
    useTeamIndex.setState({ teams: [{ id: "team", orchestrator: "thread:lead", cwd: "/lead", members: [{ teamId: "team", member: "worker" }] } as never] });
    useTabsStore.setState({ tabs: [{ id: "worker", cwd: "/worker" } as never] });
    expect(boardKeyOfTab({ id: "worker", cwd: "/worker" }, {})).toBe(sessionBoardKey("/lead", "thread:lead"));

    const project = "main|/lead#c:legacy";
    const boards = { [project]: { ...emptyBoard(), threads: { "thread:lead": { x: 0, y: 0, w: 10, h: 10 } } } };
    expect(boardKeyOfTab({ id: "worker", cwd: "/worker" }, boards)).toBe(project);
    useTeamIndex.setState({ teams: [] });
  });
});
