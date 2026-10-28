// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { hasNativeOverlay } from "../geometry";
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
it("hides Gemini for the native dialog used by ADE and restores it after close", () => {
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  vi.spyOn(dialog,"getClientRects").mockReturnValue([{width:450,height:600}] as unknown as DOMRectList);
  expect(hasNativeOverlay()).toBe(false);
  dialog.setAttribute("open", "");
  expect(hasNativeOverlay()).toBe(true);
  dialog.removeAttribute("open");
  expect(hasNativeOverlay()).toBe(false);
});
