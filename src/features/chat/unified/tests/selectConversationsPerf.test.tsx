// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type Board } from "@/features/canvas/board";
import { useCanvasStore } from "@/features/canvas/store";
import type { ThreadRow } from "@/features/chat/structured/ipc";
import { useStructured } from "@/features/chat/structured/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";

import { selectConversations, type UnifiedSources } from "../selectConversations";
import type { UnifiedConversation } from "../types";
import { useConversations } from "../useConversations";

const makeTab = (i: number, over: Partial<Tab> = {}): Tab => ({
  id: `tab-${i}`,
  title: `Aba ${i}`,
  cwd: `/repo/${i % 10}`,
  agentId: "claude-code",
  agentLabel: "Claude Code",
  command: "claude",
  ptyId: i + 1,
  openedAt: 1000 + i,
  ...over,
});

const makeThread = (i: number, over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: `th-${i}`,
  agentId: "codex",
  cwd: `/repo/${i % 10}`,
  title: `Thread ${i}`,
  model: null,
  effort: null,
  access: "ask",
  accountId: null,
  state: "active",
  createdAt: 1000 + i,
  updatedAt: 2000 + i,
  ...over,
});

describe("selectConversations: O(N) e cache compartilhado (F-R2)", () => {
  it("reaproveita o mesmo array quando chamado repetidamente com as mesmas fontes", () => {
    const src: UnifiedSources = {
      tabs: [makeTab(1), makeTab(2)],
      threads: [makeThread(1)],
      teams: [],
      boards: {},
    };
    const first = selectConversations(src);
    const second = selectConversations({ ...src });
    expect(second).toBe(first);
  });

  it("mantém a mesma referência quando uma mudança nas fontes não altera nenhuma conversa", () => {
    const tabs = [makeTab(1)];
    const threads = [makeThread(1)];
    const boardA: Board = {
      ...emptyBoard(),
      nodes: { "tab-1": { x: 10, y: 20, w: 300, h: 200 } },
    };
    const boardBMoved: Board = {
      ...emptyBoard(),
      nodes: { "tab-1": { x: 99, y: 140, w: 300, h: 200 } },
    };

    const first = selectConversations({ tabs, threads, teams: [], boards: { "main|/repo/1": boardA } });
    const afterMove = selectConversations({ tabs, threads, teams: [], boards: { "main|/repo/1": boardBMoved } });
    expect(afterMove).toBe(first);

    // Adicionar uma aba de shell não altera as conversas.
    const withShell = [...tabs, makeTab(99, { agentId: SHELL_AGENT_ID })];
    const afterShell = selectConversations({ tabs: withShell, threads, teams: [], boards: { "main|/repo/1": boardBMoved } });
    expect(afterShell).toBe(first);
  });

  it("escala linearmente com N grande (2.000 conversas e arestas legadas)", () => {
    const tabs = Array.from({ length: 1000 }, (_, i) => makeTab(i));
    const threads = Array.from({ length: 1000 }, (_, i) => makeThread(i));
    const edges = Array.from({ length: 500 }, (_, i) => ({
      id: `e-${i}`,
      a: `tab-${i * 2}`,
      b: `thread:th-${i * 2}`,
    }));
    const folderBoard: Board = { ...emptyBoard(), edges };
    const boards: Record<string, Board> = { "main|/repo/0": folderBoard };

    const out = selectConversations({ tabs, threads, teams: [], boards });
    expect(out).toHaveLength(2000);
    // Aresta legada na pasta /repo/0 manteve tab-0 e thread:th-0 no board da pasta.
    const byRef = new Map(out.map((c) => [c.ref, c]));
    expect(byRef.get("tab-0")?.boardKey).toBe("main|/repo/0");
    expect(byRef.get("thread:th-0")?.boardKey).toBe("main|/repo/0");
    // Conversa sem aresta vai para a sessão própria.
    expect(byRef.get("tab-1")?.boardKey).toBe("main|/repo/1#s:tab-1");
  });

  describe("useConversations compartilhado entre múltiplos hooks", () => {
    let root: Root;
    let host: HTMLDivElement;

    beforeEach(() => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      useTabsStore.setState({ tabs: [makeTab(1), makeTab(2)], activeTabId: "tab-1" });
      useStructured.setState({ threads: [makeThread(1)] });
      useTeamIndex.setState({ teams: [] });
      useCanvasStore.setState({ boards: {} });
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    });

    afterEach(async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    });

    it("9 consumidores de useConversations recebem exatamente a mesma referência sem recalcular por hook", async () => {
      const seen: UnifiedConversation[][] = [];
      function Consumer({ slot }: { slot: number }) {
        seen[slot] = useConversations();
        return null;
      }

      await act(async () => {
        root.render(
          <>
            {Array.from({ length: 9 }, (_, i) => <Consumer key={i} slot={i} />)}
          </>,
        );
      });

      expect(seen).toHaveLength(9);
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBe(seen[0]);
      }
      expect(seen[0]?.map((c) => c.ref)).toEqual(["thread:th-1", "tab-2", "tab-1"]);
    });
  });
});
