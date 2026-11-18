// @vitest-environment happy-dom
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: () => Promise.resolve({}) }));

import { InAppNotices } from "../InAppNotices";
import { useLiveSummary } from "../liveSummary";
import { usePendingAsks } from "../permissions/permissionsStore";
import { EMPTY_LIVE, type ThreadLive } from "../structured/model";
import { useStructured } from "../structured/store";
import { useChatLive } from "../liveStore";

// Uma conversa por protocolo, ativa, e o texto que chega nela. Os consumidores leem o estado dela pelo store real.
const thread = { id: "t1", agentId: "claude-code", cwd: "/p/ade", title: "Conversa", model: null, effort: null, access: "ask", accountId: null, state: "active", parentRef: null } as never;
const withText = (live: Record<string, ThreadLive>, text: string) => ({
  ...live,
  t1: { ...(live.t1 as ThreadLive), items: [{ kind: "assistant", id: "a1", text }] },
});

let commits = 0;
let root: Root;
let host: HTMLDivElement;
const profiled = (node: React.ReactNode) => (
  <Profiler id="consumidor" onRender={() => { commits++; }}>{node}</Profiler>
);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  commits = 0;
  useStructured.setState({ threads: [thread], live: { t1: { ...EMPTY_LIVE } }, goals: {}, goalNotices: {}, hydrated: {}, hydrateErrors: {}, logFailures: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const pushText = () => act(async () => {
  useStructured.setState((s) => ({ live: withText(s.live, "pedaço de texto") }) as never);
});

describe("os consumidores do estado ao vivo não re-renderizam com o texto do streaming", () => {
  it("in_app_notices_nao_renderiza_com_texto: a central de avisos não re-renderiza quando chega um pedaço de texto", async () => {
    await act(async () => { root.render(profiled(<InAppNotices />)); });
    await act(async () => {});
    commits = 0;
    await pushText();
    expect(commits).toBe(0);
  });

  it("pedidos_pendentes_nao_renderizam_com_texto: quem lista os pedidos não re-renderiza com o texto", async () => {
    const Probe = () => { usePendingAsks(); return null; };
    await act(async () => { root.render(profiled(<Probe />)); });
    await act(async () => {});
    commits = 0;
    await pushText();
    expect(commits).toBe(0);
  });

  it("pedidos_pendentes_nao_recalculam_com_turno_de_outra_aba: um turno que muda numa aba sem pedido na TUI não refaz a lista", async () => {
    const Probe = () => { usePendingAsks(); return null; };
    await act(async () => { root.render(profiled(<Probe />)); });
    await act(async () => {});
    commits = 0;
    await act(async () => {
      useChatLive.setState((s) => ({ turn: { ...s.turn, outra: { startedAt: 1, endedAt: null, tools: [{ name: "bash", summary: "ls" }] } } }));
    });
    expect(commits).toBe(0);
  });

  it("resumo_ao_vivo_nao_serializa_no_caminho_quente: o resumo da linha não passa por JSON.stringify a cada pedaço", async () => {
    let seen: unknown = null;
    const Probe = () => { seen = useLiveSummary("thread:t1"); return null; };
    await act(async () => { root.render(profiled(<Probe />)); });
    await act(async () => {});
    const stringify = vi.spyOn(JSON, "stringify");
    await pushText();
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(seen).toMatchObject({ working: false, waiting: false });
  });

  it("o resumo ao vivo acompanha o turno: uma ferramenta em andamento aparece como atividade", async () => {
    let seen: { working: boolean; activity: { kind: string } } | null = null;
    const Probe = () => { seen = useLiveSummary("thread:t1") as typeof seen; return null; };
    await act(async () => { root.render(profiled(<Probe />)); });
    await act(async () => {});
    await act(async () => {
      useStructured.setState((s) => ({
        live: { ...s.live, t1: { ...(s.live.t1 as ThreadLive), phase: "working", items: [
          { kind: "user", id: "u", text: "faça", at: 1000 },
          { kind: "tool", id: "c1", tool: "command", label: "bun test", status: "running" },
        ] } },
      }) as never);
    });
    expect(seen).toMatchObject({ working: true, activity: { kind: "tool" } });
  });
});
