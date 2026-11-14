// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useRevealedText } from "../timeline/useRevealedText";

function Text({ id, value, live }: { id: string; value: string; live: boolean }) {
  const result = useRevealedText(id, value, true, live);
  return <p data-revealing={result.revealing}>{result.text}</p>;
}

describe("texto que chega pelo stream", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it("pinta cada lote de deltas inteiro e mantém o texto completo ao encerrar o turno", async () => {
    const id = `stream-${crypto.randomUUID()}`;
    await act(async () => { root.render(<Text id={id} value="Olá" live />); });
    expect(host.textContent).toBe("Olá");
    expect(host.querySelector("p")?.getAttribute("data-revealing")).toBe("false");

    await act(async () => { root.render(<Text id={id} value="Olá, resposta em streaming." live />); });
    expect(host.textContent).toBe("Olá, resposta em streaming.");

    await act(async () => { root.render(<Text id={id} value="Olá, resposta em streaming." live={false} />); });
    expect(host.textContent).toBe("Olá, resposta em streaming.");
    expect(host.querySelector("p")?.getAttribute("data-revealing")).toBe("false");
  });
});
