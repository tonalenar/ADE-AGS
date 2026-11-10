// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDesktopSnapshotTargetMounted, takeDesktopSnapshot } from "../composerCommands";

/** Um composer com o botão de SnapShot, como o `ChatComposer` monta. */
function mountComposer(target: string): HTMLButtonElement {
  const form = document.createElement("form");
  form.innerHTML = `<textarea data-chat-composer-target="${target}" data-chat-composer></textarea>`
    + `<button type="button" data-chat-desktop-snapshot>SnapShot</button>`;
  document.body.appendChild(form);
  return form.querySelector("button")!;
}

beforeEach(() => {
  // O happy-dom não calcula layout: marca tudo como visível, como um composer aberto.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("comando de SnapShot do composer", () => {
  it("existe só quando o composer da conversa tem o botão visível e habilitado", () => {
    const button = mountComposer("thread:1");
    expect(isDesktopSnapshotTargetMounted("thread:1")).toBe(true);
    expect(isDesktopSnapshotTargetMounted("thread:2")).toBe(false);
    button.disabled = true;
    expect(isDesktopSnapshotTargetMounted("thread:1")).toBe(false);
  });

  it("o atalho dispara o mesmo botão do clique e não toca em outro composer", () => {
    const first = mountComposer("thread:1");
    const other = mountComposer("thread:2");
    const onFirst = vi.fn();
    const onOther = vi.fn();
    first.addEventListener("click", onFirst);
    other.addEventListener("click", onOther);
    expect(takeDesktopSnapshot("thread:1")).toBe(true);
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onOther).not.toHaveBeenCalled();
    expect(takeDesktopSnapshot(null)).toBe(false);
  });
});
