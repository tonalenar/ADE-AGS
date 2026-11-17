import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_DEBOUNCE_MS, scheduleDebounced } from "../previewDebounce";

describe("pré-visualização do editor de HTML", () => {
  afterEach(() => vi.useRealTimers());

  it("só aplica o rascunho depois do intervalo, a última tecla ganha", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const handle: { id?: ReturnType<typeof setTimeout> } = {};
    let draft = "a";
    scheduleDebounced(handle, PREVIEW_DEBOUNCE_MS, () => seen.push(draft));
    draft = "ab";
    scheduleDebounced(handle, PREVIEW_DEBOUNCE_MS, () => seen.push(draft));
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["ab"]);
  });
});
