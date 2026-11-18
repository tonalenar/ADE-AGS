// @vitest-environment happy-dom
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import type { ConversationCard } from "../chatModel";
import { ChatSidebar } from "../ChatSidebar";
import { useShelf } from "../shelf";
import { useChatStore } from "../store";
import { EMPTY_LIVE, type ThreadLive } from "../structured/model";
import { useStructured } from "../structured/store";

// Duas conversas por protocolo (`thread:<id>`): é o caminho que assinava o `live` inteiro.
const card = (tabId: string, project: string): ConversationCard => ({
  tabId, title: `Conversa ${tabId}`, project, cwd: `/p/${project}`, branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1,
});
const CARDS = [card("thread:t1", "ADE-AGS"), card("thread:t2", "Outro")];

// Quantas vezes a barra (e o que ela contém) foi renderizada: o Profiler conta cada commit da sua subárvore.
let commits = 0;
let root: Root;
let host: HTMLDivElement;
const mount = () => act(async () => {
  root.render(
    <MemoryRouter>
      <Profiler id="barra" onRender={() => { commits++; }}>
        <ChatSidebar cards={CARDS} closed={[]} diffs={{}} selectedId="thread:t1" onCollapse={() => undefined} onAddProject={() => undefined} onReopen={() => undefined} />
      </Profiler>
    </MemoryRouter>,
  );
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useShelf.setState({ snoozed: [], settled: [], pinned: [] });
  useChatStore.setState({ composing: false, composeFolder: null });
  useStructured.setState({ threads: [], live: {}, hydrated: {} });
  commits = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a barra lateral só re-renderiza com o que ela mostra de cada conversa", () => {
  it("um pedaço de texto numa conversa não re-renderiza a barra; uma mudança de fase, sim (controle do teste)", async () => {
    useStructured.setState({ live: { t1: { ...EMPTY_LIVE }, t2: { ...EMPTY_LIVE } } });
    await mount();
    // Deixa os efeitos da montagem assentarem antes de contar.
    await act(async () => {});

    // Streaming: chega um pedaço de texto na conversa t2 (o registro muda, a fase não).
    commits = 0;
    await act(async () => {
      useStructured.setState((s) => ({
        live: { ...s.live, t2: { ...(s.live.t2 as ThreadLive), items: [{ kind: "assistant", id: "a1", text: "pedaço de texto" }] } },
      }) as never);
    });
    expect(commits).toBe(0);

    // Um pedido pendente numa conversa muda o que a barra mostra («precisa de você»): ela re-renderiza.
    commits = 0;
    await act(async () => {
      useStructured.setState((s) => ({
        live: { ...s.live, t2: { ...(s.live.t2 as ThreadLive), requests: [{ id: "r1", threadId: "t2", kind: "command", itemId: null, title: "rodar", detail: "", options: null, state: "pending", createdAt: 1 }] } },
      }) as never);
    });
    expect(commits).toBeGreaterThan(0);

    // Controle: a mesma conversa mudando de fase (ficou trabalhando) é o que a barra mostra, então ela re-renderiza.
    commits = 0;
    await act(async () => {
      useStructured.setState((s) => ({
        live: { ...s.live, t2: { ...(s.live.t2 as ThreadLive), phase: "working" } },
      }) as never);
    });
    expect(commits).toBeGreaterThan(0);
  });
});
