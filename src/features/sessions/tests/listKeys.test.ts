import { describe, expect, it } from "vitest";

import { listHandlesKey, type KeyTargetLike } from "../listKeys";

function el(tagName: string, parent: KeyTargetLike | null = null, attrs: Record<string, string> = {}): KeyTargetLike {
  return { tagName, parentElement: parent, getAttribute: (name) => attrs[name] ?? null };
}

describe("history list keyboard", () => {
  const container = el("DIV");
  const row = el("DIV", container);

  it("resumes the marked session on Enter in the container itself", () => {
    expect(listHandlesKey("Enter", container, container)).toBe(true);
  });

  it("resumes on Enter from a plain row (not a control)", () => {
    expect(listHandlesKey("Enter", row, container)).toBe(true);
  });

  it("leaves Enter on a child button to the button (Delete, Export, folder header)", () => {
    const button = el("BUTTON", row);
    expect(listHandlesKey("Enter", button, container)).toBe(false);
    const icon = el("svg", button);
    expect(listHandlesKey("Enter", icon, container)).toBe(false);
    expect(listHandlesKey("Enter", el("SPAN", row, { role: "button" }), container)).toBe(false);
    expect(listHandlesKey("Enter", el("A", row), container)).toBe(false);
  });

  it("keeps Enter in the search box resuming (the handler sits on the input itself)", () => {
    const input = el("INPUT");
    expect(listHandlesKey("Enter", input, input)).toBe(true);
    expect(listHandlesKey("ArrowDown", input, input)).toBe(true);
  });

  it("moves the mark with arrows from a child button, but not from a child text field", () => {
    expect(listHandlesKey("ArrowDown", el("BUTTON", row), container)).toBe(true);
    expect(listHandlesKey("ArrowUp", el("TEXTAREA", row), container)).toBe(false);
  });

  it("ignores other keys", () => {
    expect(listHandlesKey("Escape", container, container)).toBe(false);
  });
});
