import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_BOT_TOAST_MS, MAX_BOT_TOASTS, showBotToast, useBotToastStore } from "../botToastStore";

describe("botToastStore", () => {
  beforeEach(() => useBotToastStore.setState({ toasts: [] }));

  it("agrega el aviso con tono info y duración por defecto", () => {
    const id = showBotToast({ title: "A", text: "b" });
    const [toast] = useBotToastStore.getState().toasts;
    expect(toast).toMatchObject({ id, title: "A", text: "b", tone: "info", ms: DEFAULT_BOT_TOAST_MS });
  });

  it("solo se ven los últimos avisos: el más viejo cede su lugar", () => {
    for (let i = 0; i < MAX_BOT_TOASTS + 2; i++) showBotToast({ title: `t${i}`, text: "x" });
    const titles = useBotToastStore.getState().toasts.map((t) => t.title);
    expect(titles).toHaveLength(MAX_BOT_TOASTS);
    expect(titles[titles.length - 1]).toBe(`t${MAX_BOT_TOASTS + 1}`);
    expect(titles).not.toContain("t0");
  });

  it("descartar quita solo ese aviso", () => {
    const a = showBotToast({ title: "A", text: "x" });
    const b = showBotToast({ title: "B", text: "x", tone: "warning", ms: 1000 });
    useBotToastStore.getState().dismiss(a);
    const left = useBotToastStore.getState().toasts;
    expect(left.map((t) => t.id)).toEqual([b]);
    expect(left[0]).toMatchObject({ tone: "warning", ms: 1000 });
  });
});
