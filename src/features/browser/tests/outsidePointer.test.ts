// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { closeAppPopovers } from "../outsidePointer";

describe("closeAppPopovers", () => {
  it("repete no body o pointerdown de \"clique fora\" que os menus já escutam na janela", () => {
    const seen: EventTarget[] = [];
    const listen = (e: Event) => seen.push(e.target!);
    window.addEventListener("pointerdown", listen);
    closeAppPopovers();
    window.removeEventListener("pointerdown", listen);
    expect(seen).toEqual([document.body]);
  });
});
