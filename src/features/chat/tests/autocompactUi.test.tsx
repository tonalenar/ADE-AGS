// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/chat/autocompact/ipc", () => ({
  chatAutocompactPlans: () => Promise.resolve([
    { agentId: "claude-code", surface: "chat", measure: "resultUsage", mechanism: "nativeAuto", supported: true, adeTypes: false, reason: "nativeAutoWindow" },
    { agentId: "codex", surface: "chat", measure: "tokenUsage", mechanism: "adeCommand", supported: true, adeTypes: false, reason: "threadCompact" },
    { agentId: "cursor", surface: "chat", measure: "none", mechanism: "unsupported", supported: false, adeTypes: false, reason: "noContext" },
  ]),
  loadAutoCompactConfig: () => Promise.resolve({ enabled: true, agents: { codex: { thresholdPct: 70 } } }),
  saveAutoCompactConfig: () => Promise.resolve(),
}));
vi.mock("@/features/accounts/chatPool", () => ({ chatPoolPending: () => Promise.resolve(null), chatPoolAccept: () => Promise.resolve(), chatPoolDismiss: () => Promise.resolve() }));

import { ContextMeter } from "@/features/chat/autocompact/ContextMeter";
import { contextUsageOf } from "@/features/chat/autocompact/model";
import { NoticeRow } from "@/features/chat/timeline/NoticeRow";
import type { TimelineItem } from "@/features/chat/timeline/types";

let root: Root | null = null;
let host: HTMLDivElement;
const render = (node: React.ReactNode) => act(async () => { root!.render(node); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
});

const notice = (status: "running" | "done" | "error", extra: Partial<TimelineItem> = {}): TimelineItem =>
  ({ kind: "notice", id: "n:compaction:1", label: "compaction", status, text: "auto", at: 1, ...extra });

describe("aviso de compactação na timeline", () => {
  it("em andamento mostra «Compactando…» e quem pediu", async () => {
    await render(<NoticeRow item={notice("running", { text: "ade" })} />);
    const row = host.querySelector('[data-compaction="running"]')!;
    expect(row.textContent).toContain("chat.compaction.running");
    expect(row.textContent).toContain("chat.compaction.trigger.ade");
  });

  it("terminado mostra os tokens antes e depois", async () => {
    await render(<NoticeRow item={notice("done", { contextTokens: 182_400, tokens: 42_000 })} />);
    const text = host.querySelector('[data-compaction="done"]')!.textContent!;
    expect(text).toContain("chat.compaction.doneTokens");
    expect(text).toContain('"before":"182k"');
    expect(text).toContain('"after":"42k"');
  });

  it("sem o «depois», mostra só o «antes»; com erro, o motivo", async () => {
    await render(<NoticeRow item={notice("done", { contextTokens: 90_000 })} />);
    expect(host.textContent).toContain("chat.compaction.doneBefore");
    await render(<NoticeRow item={notice("error", { output: "sessão fechou" })} />);
    const failed = host.querySelector('[data-compaction="error"]')!;
    expect(failed.textContent).toContain("chat.compaction.failed");
    expect(failed.textContent).toContain("sessão fechou");
  });
});

describe("medidor de contexto do composer", () => {
  const items: TimelineItem[] = [{ kind: "usage", id: "u", tokens: 1, contextTokens: 150_000, contextWindow: 200_000 }];

  it("mostra a porcentagem e diz que a ADE compacta ao fim do turno a partir do limiar configurado (Codex)", async () => {
    await render(<ContextMeter usage={contextUsageOf(items, "codex")} agentId="codex" />);
    const meter = host.querySelector("[data-context-meter]")!;
    expect(meter.textContent).toContain("75%");
    expect(meter.getAttribute("title")).toContain("chat.contextMeter.on");
    expect(meter.getAttribute("title")).toContain('\\"pct\\":70');
    expect(meter.getAttribute("data-context-meter")).toBe("over");
  });

  it("no Claude Code diz que o agente compacta sozinho", async () => {
    await render(<ContextMeter usage={contextUsageOf(items, "claude-code")} agentId="claude-code" />);
    expect(host.querySelector("[data-context-meter]")!.getAttribute("title")).toContain("chat.contextMeter.native");
  });

  it("agente sem suporte explica em vez de inventar", async () => {
    await render(<ContextMeter usage={contextUsageOf(items, "claude-code")} agentId="cursor" />);
    expect(host.querySelector("[data-context-meter]")!.getAttribute("title")).toContain("chat.contextMeter.unsupported");
  });

  it("sem medida de contexto não desenha nada", async () => {
    await render(<ContextMeter usage={null} agentId="codex" />);
    expect(host.querySelector("[data-context-meter]")).toBeNull();
  });
});
