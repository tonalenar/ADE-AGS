/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && !("defaultValue" in o) ? `${k} ${JSON.stringify(o)}` : k) }) }));

const promote = vi.fn();
const discard = vi.fn();
vi.mock("../ipc", () => ({
  promoteMemoryAgentDraft: (...a: unknown[]) => promote(...a),
  discardMemoryAgentDraft: (...a: unknown[]) => discard(...a),
}));

import { DRAFT_QUEUE_LIMIT, PENDING_LIMIT, draftNotice, maxPendingPerOwner, toDraftView } from "../agentDrafts";
import { DraftsSection, type DraftsState } from "../DraftsSection";
import type { MemoryAgentDraft } from "../types";

const draft = (over: Partial<MemoryAgentDraft> = {}, proposal: unknown = { key: "k1", kind: "decision", body: "Corpo", operation: "upsert" }): MemoryAgentDraft => ({
  id: "d1", scope: "workspace", missionId: null, proposal: typeof proposal === "string" ? proposal : JSON.stringify(proposal), actorKind: "worker", createdAt: 1, status: "agent_draft", ...over,
});

describe("toDraftView / draftNotice", () => {
  it("lê a proposta JSON", () => {
    const v = toDraftView(draft());
    expect(v).toMatchObject({ key: "k1", body: "Corpo", kind: "decision", readable: true });
  });
  it("JSON inválido ou sem chave/corpo: ilegível, sem inventar", () => {
    expect(toDraftView(draft({}, "{nao e json")).readable).toBe(false);
    expect(toDraftView(draft({}, "[1,2]")).readable).toBe(false);
    expect(toDraftView(draft({}, { key: "x" })).readable).toBe(false);
    expect(toDraftView(draft({}, { key: 5, body: {} })).key).toBeNull();
  });
  it("trunca texto enorme", () => {
    expect(toDraftView(draft({}, { key: "k", body: "x".repeat(5000) })).body!.length).toBeLessThan(700);
  });
  it("P3: contagem por dono vinda do backend (memory_pending_counts)", () => {
    // 16 do workspace de M1 + 16 do workspace de M2 = dono workspace com 32: cheio.
    const full = { workspace: 32, byMission: { m1: 0, m2: 0 } };
    expect(maxPendingPerOwner(full)).toBe(32);
    expect(draftNotice(2, maxPendingPerOwner(full))).toBe("inboxFull");
    // 16 workspace + 16 mission de M1 são donos diferentes: nenhum está cheio.
    const split = { workspace: 16, byMission: { m1: 16 } };
    expect(maxPendingPerOwner(split)).toBe(16);
    expect(draftNotice(2, maxPendingPerOwner(split))).toBeNull();
    // uma missão cheia sozinha enche.
    expect(maxPendingPerOwner({ workspace: 3, byMission: { a: 5, b: 32 } })).toBe(32);
    expect(maxPendingPerOwner({ workspace: 0, byMission: {} })).toBe(0);
  });
  it("sem dado (carregando ou erro): sem aviso, nunca inventa", () => {
    expect(maxPendingPerOwner(null)).toBeNull();
    expect(maxPendingPerOwner(undefined)).toBeNull();
    expect(draftNotice(2, null)).toBeNull();
    expect(draftNotice(DRAFT_QUEUE_LIMIT, null)).toBe("queueFull");
  });
  it("avisos: fila cheia pesa mais que caixa cheia", () => {
    expect(draftNotice(0, 0)).toBeNull();
    expect(draftNotice(3, PENDING_LIMIT - 1)).toBeNull();
    expect(draftNotice(3, PENDING_LIMIT)).toBe("inboxFull");
    expect(draftNotice(DRAFT_QUEUE_LIMIT, PENDING_LIMIT)).toBe("queueFull");
  });
});

describe("DraftsSection", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onChanged = vi.fn();
  const onReload = vi.fn();
  beforeEach(() => {
    promote.mockReset().mockResolvedValue({});
    discard.mockReset().mockResolvedValue(undefined);
    onChanged.mockReset();
    onReload.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = async (state: DraftsState, pending = 0) => {
    await act(async () => { root.render(<DraftsSection workspaceId="w1" state={state} pending={pending} onReload={onReload} onChanged={onChanged} />); });
  };
  const btn = (txt: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === txt)!;

  it("carregando, vazio e erro com tentar de novo", async () => {
    await render({ status: "loading" });
    expect(host.textContent).toContain("memoryDrafts.loading");
    expect(host.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    await render({ status: "ready", drafts: [] });
    expect(host.textContent).toContain("memoryDrafts.empty");
    await render({ status: "error" });
    await act(async () => { btn("memoryDrafts.retry").click(); });
    expect(onReload).toHaveBeenCalled();
  });

  it("promover chama o IPC e recarrega; nunca aprova", async () => {
    await render({ status: "ready", drafts: [draft()] });
    await act(async () => { btn("memoryDrafts.promote").click(); });
    expect(promote).toHaveBeenCalledWith("w1", "d1");
    expect(onChanged).toHaveBeenCalled();
    expect(host.textContent).toContain("memoryDrafts.note");
  });

  it("descartar chama o IPC", async () => {
    await render({ status: "ready", drafts: [draft()] });
    await act(async () => { btn("memoryDrafts.discard").click(); });
    expect(discard).toHaveBeenCalledWith("w1", "d1");
    expect(onChanged).toHaveBeenCalled();
  });

  it("erro ao promover (caixa cheia) mostra alerta e não recarrega", async () => {
    promote.mockRejectedValue(new Error("pending inbox is full"));
    await render({ status: "ready", drafts: [draft()] });
    await act(async () => { btn("memoryDrafts.promote").click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("memoryDrafts.promoteFailed");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("aviso de caixa cheia com 32 pendentes", async () => {
    await render({ status: "ready", drafts: [draft()] }, 32);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("memoryDrafts.notice.inboxFull.title");
  });

  it("rascunho ilegível não pode ser promovido", async () => {
    await render({ status: "ready", drafts: [draft({}, "{ruim")] });
    expect(btn("memoryDrafts.promote").disabled).toBe(true);
    expect(btn("memoryDrafts.discard").disabled).toBe(false);
  });

  it("conteúdo do agente com HTML vira texto", async () => {
    await render({ status: "ready", drafts: [draft({}, { key: "<b>k</b>", body: "<img src=x onerror=1>" })] });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
  });
});
