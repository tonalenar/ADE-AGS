/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, o?: { key?: string }) => (o?.key ? `${k}:${o.key}` : k) }) }));

import { ReviewMarks } from "../ReviewMarks";
import { reviewFlag, reviewMarks } from "../review";
import type { MemoryReviewItem } from "../types";

const ref = (key: string) => ({ entryId: `e-${key}`, key, revision: 1 });
const item = (over: Record<string, unknown> = {}) => ({ key: "k", body: "b", score: 1, ...over }) as unknown as MemoryReviewItem;

describe("reviewMarks", () => {
  it("sem marcas: lista vazia", () => expect(reviewMarks(item())).toEqual([]));
  it("só duplicata", () => expect(reviewMarks(item({ duplicateOf: ref("a") }))).toEqual([{ kind: "duplicate", key: "a" }]));
  it("só contradição", () => expect(reviewMarks(item({ contradicts: ref("b") }))).toEqual([{ kind: "contradiction", key: "b" }]));
  it("as duas ao mesmo tempo, sem perder nenhuma", () => {
    const i = item({ duplicateOf: ref("a"), contradicts: ref("b") });
    expect(reviewMarks(i).map((m) => m.kind)).toEqual(["duplicate", "contradiction"]);
    expect(reviewFlag(i)).toBe("contradiction");
  });
});

describe("ReviewMarks", () => {
  const render = (i: MemoryReviewItem) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<ReviewMarks item={i} />));
    return { host, done: () => { act(() => root.unmount()); host.remove(); } };
  };

  it("mostra as duas marcas como 'possível' e a nota de decisão", () => {
    const { host, done } = render(item({ duplicateOf: ref("dev-sem-watcher"), contradicts: ref("dev-com-watcher") }));
    expect(host.querySelector('[data-mark="duplicate"]')?.textContent).toBe("memoryReview.markDuplicate:dev-sem-watcher");
    expect(host.querySelector('[data-mark="contradiction"]')?.textContent).toBe("memoryReview.markContradiction:dev-com-watcher");
    expect(host.textContent).toContain("memoryReview.markNote");
    expect(host.querySelectorAll("button").length).toBe(0);
    done();
  });

  it("não renderiza nada sem marcas", () => {
    const { host, done } = render(item());
    expect(host.innerHTML).toBe("");
    done();
  });

  it("chave com HTML vira texto", () => {
    const { host, done } = render(item({ duplicateOf: ref("<img src=x onerror=1>") }));
    expect(host.querySelector("img")).toBeNull();
    done();
  });
});
