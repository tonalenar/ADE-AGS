// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ storageGet: vi.fn(), storageSet: vi.fn(), storageClear: vi.fn() }));
vi.mock("../designApi", () => ({ designApi: api }));

import { BOOT_HOST_MSG, BOOT_MSG } from "../artboardBoot";
import { isAppDark, postThemeToFrames } from "../artboardBridge";
import { ensureArtboardStorage, frameErrorsOf, snapshotOf } from "../artboardStore";

const frameFor = (id: string) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("data-artboard-id", id);
  document.body.appendChild(frame);
  return frame;
};

describe("ponte entre as pranchetas e o app", () => {
  beforeEach(() => {
    api.storageGet.mockReset().mockResolvedValue({ local: {}, session: {} });
    document.body.innerHTML = "";
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("o tema do app é o da classe dark ou do data-theme do html", () => {
    expect(isAppDark()).toBe(false);
    document.documentElement.classList.add("dark");
    expect(isAppDark()).toBe(true);
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "dark");
    expect(isAppDark()).toBe(true);
  });

  it("trocar o tema manda a mensagem às pranchetas vivas, sem tocar no srcdoc", () => {
    const frame = frameFor("art-theme");
    frame.srcdoc = "<p>igual</p>";
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    document.documentElement.classList.add("dark");
    postThemeToFrames();
    expect(post).toHaveBeenCalledWith({ type: BOOT_HOST_MSG, kind: "theme", dark: true }, "*");
    expect(frame.srcdoc).toBe("<p>igual</p>");
  });

  it("a gravação que a prancheta manda chega ao snapshot dela pela janela do iframe", async () => {
    const frame = frameFor("art-msg");
    ensureArtboardStorage("art-msg");
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: BOOT_MSG, kind: "storage", op: "set", area: "local", key: "nome", value: "Ana" },
      source: frame.contentWindow,
    }));
    expect(snapshotOf("art-msg").local).toEqual({ nome: "Ana" });
  });

  it("um erro que a prancheta manda aparece na lista dela, e mensagem de outra janela é ignorada", () => {
    const frame = frameFor("art-erro");
    window.dispatchEvent(new MessageEvent("message", { data: { type: BOOT_MSG, kind: "error", message: "boom", line: 7 }, source: frame.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: BOOT_MSG, kind: "error", message: "de fora", line: 1 }, source: window }));
    expect(frameErrorsOf("art-erro")).toEqual([expect.objectContaining({ message: "boom", line: 7 })]);
    expect(frameErrorsOf("art-erro")).toHaveLength(1);
  });
});
