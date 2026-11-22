// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOT_HOST_MSG, BOOT_MSG, STORAGE_LIMIT_BYTES, applyStorageDelta, artboardBootScript, emptySnapshot, parseBootMessage, sanitizeSnapshot, snapshotBytes,
} from "../artboardBoot";
import { buildSrcdoc } from "../srcdoc";

describe("tamanho do armazenamento da prancheta", () => {
  it("conta bytes UTF-8 de chaves e valores das duas áreas, como o backend", () => {
    expect(snapshotBytes({ local: { "ç": "é" }, session: { a: "b" } })).toBe(6);
  });

  it("o limite é 1 MiB por prancheta", () => {
    expect(STORAGE_LIMIT_BYTES).toBe(1024 * 1024);
  });
});

describe("applyStorageDelta", () => {
  it("grava e apaga por área sem mexer na outra", () => {
    const set = applyStorageDelta(emptySnapshot(), { kind: "storage", op: "set", area: "local", key: "k", value: "v" });
    expect(set).toMatchObject({ ok: true, snapshot: { local: { k: "v" }, session: {} } });
    const removed = applyStorageDelta(set.ok ? set.snapshot : emptySnapshot(), { kind: "storage", op: "remove", area: "local", key: "k" });
    expect(removed).toMatchObject({ ok: true, snapshot: { local: {}, session: {} } });
  });

  it("recusa a gravação que passa de 1 MiB e não altera o estado", () => {
    const full = applyStorageDelta(emptySnapshot(), { kind: "storage", op: "set", area: "local", key: "k", value: "a".repeat(STORAGE_LIMIT_BYTES - 1) });
    expect(full.ok).toBe(true);
    const over = applyStorageDelta(full.ok ? full.snapshot : emptySnapshot(), { kind: "storage", op: "set", area: "session", key: "j", value: "x" });
    expect(over).toEqual({ ok: false, reason: "quota" });
  });

  it("trocar o valor de uma chave conta só a diferença", () => {
    const big = applyStorageDelta(emptySnapshot(), { kind: "storage", op: "set", area: "local", key: "k", value: "a".repeat(1000) });
    const small = applyStorageDelta(big.ok ? big.snapshot : emptySnapshot(), { kind: "storage", op: "set", area: "local", key: "k", value: "b".repeat(STORAGE_LIMIT_BYTES - 2) });
    expect(small.ok).toBe(true);
  });
});

describe("sanitizeSnapshot (o que volta do backend)", () => {
  it("descarta o que não é texto e tolera lixo", () => {
    expect(sanitizeSnapshot({ local: { a: "1", b: 2, c: null }, session: "x" })).toEqual({ local: { a: "1" }, session: {} });
    expect(sanitizeSnapshot(null)).toEqual(emptySnapshot());
  });
});

describe("parseBootMessage", () => {
  it("aceita gravar, apagar, limpar e erro; recusa o resto", () => {
    expect(parseBootMessage({ type: BOOT_MSG, kind: "storage", op: "set", area: "local", key: "a", value: "b" }))
      .toEqual({ kind: "storage", op: "set", area: "local", key: "a", value: "b" });
    expect(parseBootMessage({ type: BOOT_MSG, kind: "storage", op: "clear", area: "session" }))
      .toEqual({ kind: "storage", op: "clear", area: "session" });
    expect(parseBootMessage({ type: BOOT_MSG, kind: "storage", op: "set", area: "cookie", key: "a", value: "b" })).toBeNull();
    expect(parseBootMessage({ type: BOOT_MSG, kind: "storage", op: "set", area: "local", key: 1, value: "b" })).toBeNull();
    expect(parseBootMessage({ type: "outra", kind: "storage", op: "clear", area: "local" })).toBeNull();
    expect(parseBootMessage(null)).toBeNull();
  });

  it("erro: a mensagem corta em 300 caracteres e a linha é opcional", () => {
    expect(parseBootMessage({ type: BOOT_MSG, kind: "error", message: "x".repeat(500), line: 12 }))
      .toEqual({ kind: "error", message: "x".repeat(300), line: 12 });
    expect(parseBootMessage({ type: BOOT_MSG, kind: "error", message: 42 })).toBeNull();
  });
});

describe("artboardBootScript e o srcdoc", () => {
  it("o estado embutido não consegue fechar a tag <script>", () => {
    const src = artboardBootScript({ storage: { local: { x: "</script><script>alert(1)</script>" }, session: {} }, dark: false });
    expect(src).not.toContain("</script>");
    expect(src).not.toContain("<script>");
  });

  it("buildSrcdoc põe o boot no head, antes do HTML do agente", () => {
    const doc = buildSrcdoc("<p id=\"x\">oi</p>", { storage: { local: { a: "1" }, session: {} }, dark: true });
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    const headScripts = [...parsed.head.querySelectorAll("script")];
    expect(headScripts).toHaveLength(1);
    expect(headScripts[0].textContent).toContain(BOOT_MSG);
    expect(parsed.body.querySelector("#x")).not.toBeNull();
  });
});

describe("boot da prancheta em execução (happy-dom)", () => {
  const posts: Array<Record<string, unknown>> = [];
  const run = (opts: Parameters<typeof artboardBootScript>[0]) => { new Function(artboardBootScript(opts))(); };

  beforeEach(() => {
    posts.length = 0;
    vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => { posts.push(m); }) as typeof window.postMessage);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("localStorage e sessionStorage começam com o que o backend guardou", () => {
    run({ storage: { local: { nome: "Ana" }, session: { aba: "1" } }, dark: false });
    expect(window.localStorage.getItem("nome")).toBe("Ana");
    expect(window.sessionStorage.getItem("aba")).toBe("1");
    expect(window.localStorage.getItem("ausente")).toBeNull();
  });

  it("gravar, apagar e limpar avisam o app, por área", () => {
    run({ storage: emptySnapshot(), dark: false });
    window.localStorage.setItem("k", "v");
    expect(posts).toContainEqual({ type: BOOT_MSG, kind: "storage", op: "set", area: "local", key: "k", value: "v" });
    window.sessionStorage.setItem("s", "1");
    expect(posts).toContainEqual({ type: BOOT_MSG, kind: "storage", op: "set", area: "session", key: "s", value: "1" });
    window.localStorage.removeItem("k");
    expect(posts).toContainEqual({ type: BOOT_MSG, kind: "storage", op: "remove", area: "local", key: "k" });
    window.localStorage.setItem("z", "1");
    window.localStorage.clear();
    expect(posts).toContainEqual({ type: BOOT_MSG, kind: "storage", op: "clear", area: "local" });
  });

  it("passar de 1 MiB lança QuotaExceededError e não avisa o app", () => {
    run({ storage: emptySnapshot(), dark: false });
    window.localStorage.setItem("a", "x".repeat(STORAGE_LIMIT_BYTES - 1));
    posts.length = 0;
    let failure: unknown = null;
    try { window.sessionStorage.setItem("b", "y".repeat(10)); } catch (e) { failure = e; }
    expect((failure as DOMException | null)?.name).toBe("QuotaExceededError");
    expect(posts.filter((m) => m.kind === "storage")).toHaveLength(0);
  });

  it("dark vira data-theme e prefers-color-scheme; a mensagem do tema troca sem recarregar", () => {
    run({ storage: emptySnapshot(), dark: true });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    expect(dark.matches).toBe(true);
    expect(window.matchMedia("(prefers-color-scheme: light)").matches).toBe(false);
    const changes: boolean[] = [];
    dark.addEventListener("change", (e: Event) => changes.push((e as MediaQueryListEvent).matches));
    window.dispatchEvent(new MessageEvent("message", { data: { type: BOOT_HOST_MSG, kind: "theme", dark: false }, source: window }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(dark.matches).toBe(false);
    expect(changes).toEqual([false]);
  });

  it("erro não tratado da prancheta vai ao app com a mensagem e a linha", () => {
    run({ storage: emptySnapshot(), dark: false });
    posts.length = 0;
    window.dispatchEvent(new ErrorEvent("error", { message: "ReferenceError: foo is not defined", lineno: 3 }));
    expect(posts).toContainEqual({ type: BOOT_MSG, kind: "error", message: "ReferenceError: foo is not defined", line: 3 });
  });

  it("console.error da prancheta também vai ao app", () => {
    run({ storage: emptySnapshot(), dark: false });
    posts.length = 0;
    console.error("falhou", 42);
    expect(posts).toContainEqual({ type: BOOT_MSG, kind: "error", message: "falhou 42", line: null });
  });
});
