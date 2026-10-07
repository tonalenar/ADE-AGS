/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import ptBR from "@/i18n/locales/pt-BR.json";

const mock = vi.hoisted(() => ({
  list: vi.fn(), query: vi.fn(), stats: vi.fn(), verify: vi.fn(), listen: vi.fn(),
}));
vi.mock("../ipc", () => ({
  listMemory: mock.list,
  queryMemory: mock.query,
  getMemoryWorkspaceStats: mock.stats,
  verifyMemorySource: mock.verify,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      let text = (ptBR as Record<string, string>)[key] ?? key;
      for (const [k, v] of Object.entries(options ?? {})) text = text.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      return text;
    },
    i18n: { language: "pt-BR" },
  }),
}));
vi.mock("neogestify-ui-components", () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) =>
    createElement("button", { onClick, disabled }, children),
}));

import { SharedMemoryPanel } from "../SharedMemoryPanel";
import { EMPTY_SEARCH, isEmptySearch, toFilter, verificationOf } from "../memorySearch";
import type { MemoryEntry } from "../types";

const DAY = 86_400;
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "e1", scope: "workspace", workspaceId: "w1", missionId: null, key: "architecture", kind: "note", status: "active",
  currentRevision: 1, priority: 0, body: "SQLite", authorKind: "user", sourceRunId: null, sourceTaskId: null, sourceFactId: null,
  createdAt: 1, updatedAt: 1, pendingRevision: null, pendingOperation: null, pendingKind: null, pendingPriority: null,
  pendingBody: null, pendingActorKind: null, pendingSourceRunId: null, pendingSourceTaskId: null, pendingSourceFactId: null,
  pendingReason: null, pendingCreatedAt: null, ...over,
});
const page = (items: MemoryEntry[], more = false, cursor: string | null = null) => ({ items, hasMore: more, nextCursor: cursor, truncated: false });

describe("memorySearch (puro)", () => {
  it("estado vazio não filtra", () => {
    expect(toFilter(EMPTY_SEARCH)).toEqual({});
    expect(isEmptySearch(EMPTY_SEARCH)).toBe(true);
    expect(isEmptySearch({ ...EMPTY_SEARCH, query: "   " })).toBe(true);
  });
  it("mapeia tipo, estado, marcas e vencida para o filtro do backend", () => {
    expect(toFilter({ query: " abc ", kind: "note", status: "pending", marks: "both", expired: true })).toEqual({
      query: "abc", kind: "note", status: "pending", duplicateOf: true, contradicts: true, verificationExpired: true,
    });
    expect(toFilter({ ...EMPTY_SEARCH, marks: "duplicate" })).toEqual({ duplicateOf: true });
    expect(toFilter({ ...EMPTY_SEARCH, marks: "contradiction" })).toEqual({ contradicts: true });
  });
  it("verificação: sem TTL nunca vence; TTL sem last_verified vence; passado do TTL vence", () => {
    const now = 1_000_000 * DAY;
    expect(verificationOf({}, now)).toEqual({ state: "none" });
    expect(verificationOf({ ttlDays: 90 }, now)).toEqual({ state: "never", ttlDays: 90 });
    expect(verificationOf({ lastVerified: now - 3 * DAY, ttlDays: 90 }, now)).toEqual({ state: "ok", ttlDays: 90, daysAgo: 3 });
    expect(verificationOf({ lastVerified: now - 94 * DAY, ttlDays: 90 }, now)).toMatchObject({ state: "expired", daysAgo: 94 });
    expect(verificationOf({ lastVerified: now - 500 * DAY, ttlDays: null }, now)).toMatchObject({ state: "ok", ttlDays: null });
    expect(verificationOf({ lastVerified: now - 90 * DAY, ttlDays: 90 }, now).state).toBe("expired");
  });
});

describe("SharedMemoryPanel: busca e filtros", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    for (const m of Object.values(mock)) m.mockReset();
    mock.list.mockResolvedValue(page([entry()]));
    mock.query.mockResolvedValue(page([entry({ key: "found" })]));
    mock.stats.mockResolvedValue({ entries: 41, revisions: 50, deletedAt: null, deleteAfter: null, memoryUsage: { timesUsed: 9, entriesUsed: 6, runsUsingMemory: 3, method: "selected_in_run_snapshot" } });
    mock.listen.mockResolvedValue(() => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const render = async (props: Record<string, unknown> = {}) => {
    await act(async () => { root.render(createElement(SharedMemoryPanel, { workspaceId: "w1", ...props })); });
    await act(async () => {});
  };
  const type = async (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    await act(async () => { el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const select = async (label: string, value: string) => {
    const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    await act(async () => { el.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it("sem filtro usa listMemory (como antes) e mostra a memória usada", async () => {
    await render();
    expect(mock.list).toHaveBeenCalledWith("w1", null);
    expect(mock.query).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Memória usada: 41 entradas · 6 usadas em 3 Runs");
  });

  it("busca com debounce: um único queryMemory depois da pausa", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await type(input, "ab");
    await type(input, "abc");
    expect(mock.query).not.toHaveBeenCalled();
    await flush(350);
    expect(mock.query).toHaveBeenCalledTimes(1);
    expect(mock.query).toHaveBeenCalledWith("w1", null, { query: "abc" }, undefined);
    expect(container.textContent).toContain("found");
  });

  it("filtros de tipo, estado, marcas e vencida chegam ao backend", async () => {
    await render();
    await select("Tipo", "decision");
    await select("Estado", "pending");
    await select("Marcas", "both");
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await flush(350);
    expect(mock.query).toHaveBeenLastCalledWith("w1", null, { kind: "decision", status: "pending", duplicateOf: true, contradicts: true, verificationExpired: true }, undefined);
  });

  it("Carregar mais usa o CURSOR do backend (nunca offset)", async () => {
    mock.query.mockResolvedValue(page([entry({ id: "e1", key: "found" })], true, "CURSOR-1"));
    await render();
    await select("Tipo", "decision");
    await flush(350);
    mock.query.mockResolvedValue(page([entry({ id: "e2", key: "second" })]));
    const more = [...container.querySelectorAll("button")].find((b) => b.textContent === "Carregar mais")!;
    await act(async () => { more.click(); });
    expect(mock.query).toHaveBeenLastCalledWith("w1", null, { kind: "decision" }, "CURSOR-1");
    expect(container.textContent).toContain("found");
    expect(container.textContent).toContain("second");
  });

  it("estado vazio com filtro e erro com tentar de novo", async () => {
    await render();
    mock.query.mockResolvedValue(page([]));
    await select("Tipo", "file");
    await flush(350);
    expect(container.textContent).toContain("Nada encontrado para esses filtros.");
    mock.query.mockRejectedValue(new Error("falhou"));
    await select("Tipo", "note");
    await flush(350);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("falhou");
    mock.query.mockResolvedValue(page([entry({ key: "back" })]));
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Tentar de novo")!;
    await act(async () => { retry.click(); });
    await act(async () => {});
    expect(container.textContent).toContain("back");
  });

  it("mostra carregando enquanto a consulta não volta", async () => {
    await render();
    mock.query.mockReturnValue(new Promise(() => undefined));
    await select("Tipo", "file");
    await flush(350);
    expect(container.textContent).toContain("Carregando…");
  });

  it("indicador last_verified/TTL: vencida, nunca verificada e dentro do prazo", async () => {
    const now = Math.floor(Date.now() / 1000);
    mock.list.mockResolvedValue(page([
      entry({ id: "a", key: "a", lastVerified: now - 94 * DAY, ttlDays: 90 }),
      entry({ id: "b", key: "b", ttlDays: 30 }),
      entry({ id: "c", key: "c", lastVerified: now - 3 * DAY, ttlDays: 90 }),
    ]));
    await render();
    const pills = [...container.querySelectorAll("[data-verification]")].map((e) => [e.getAttribute("data-verification"), e.textContent]);
    expect(pills.map((p) => p[0])).toEqual(["expired", "never", "ok"]);
    expect(pills[0][1]).toContain("94 dias");
    expect(pills[0][1]).toContain("vencida");
  });

  it("Conferir fonte é somente leitura e mostra o resultado", async () => {
    mock.verify.mockResolvedValue({ runExists: true, taskExists: false, fileExists: null, commitExists: null, lastVerifiedChanged: false });
    await render();
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Conferir fonte")!;
    await act(async () => { btn.click(); });
    expect(mock.verify).toHaveBeenCalledWith("e1");
    const res = container.querySelector('[role="status"]')!.textContent!;
    expect(res).toContain("Run: existe");
    expect(res).toContain("Task: não existe");
    expect(res).toContain("Arquivo: n/d");
    expect(res).toContain("Só leitura");
  });

  it("Conferir fonte com erro mostra alerta", async () => {
    mock.verify.mockRejectedValue(new Error("sem fonte"));
    await render();
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Conferir fonte")!;
    await act(async () => { btn.click(); });
    expect(container.textContent).toContain("sem fonte");
  });

  it("filtro de escopo só aparece com missão", async () => {
    await render();
    expect(container.querySelector('select[aria-label="Escopo"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await render({ missionId: "m1" });
    expect(container.querySelector('select[aria-label="Escopo"]')).not.toBeNull();
  });

  it("conteúdo malicioso vira texto", async () => {
    mock.list.mockResolvedValue(page([entry({ key: "<img src=x onerror=1>", body: "<script>x()</script>" })]));
    await render();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
