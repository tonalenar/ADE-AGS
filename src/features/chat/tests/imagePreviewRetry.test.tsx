// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readImage = vi.fn();
vi.mock("@/features/chat/attachments/ipc", () => ({ readImage: (path: string) => readImage(path) }));

import { PREVIEW_RETRY_DELAYS_MS, useImagePreview } from "@/features/chat/attachments/useImagePreview";

function Probe({ path }: { path: string }) {
  const { src, missing } = useImagePreview(path, null);
  return <span data-testid="p">{src ?? (missing ? "indisponivel" : "carregando")}</span>;
}

let root: Root;
let host: HTMLDivElement;
const text = () => host.querySelector("[data-testid=p]")?.textContent;
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  readImage.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe("prévia de imagem que o agente ainda está gravando", () => {
  it("tenta_de_novo_e_mostra_a_imagem_quando_o_arquivo_aparece", async () => {
    // A resposta cita o arquivo antes de a ferramenta terminar de gravá-lo: a primeira leitura falha.
    readImage.mockRejectedValueOnce(new Error("arquivo não encontrado")).mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
    await act(async () => { root.render(<Probe path="/p/folha.png" />); });
    await flush();
    expect(text()).toBe("indisponivel");

    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_RETRY_DELAYS_MS[0]!); });
    expect(text()).toBe("data:image/png;base64,AA==");
  });

  it("para_de_tentar_depois_do_limite", async () => {
    readImage.mockRejectedValue(new Error("não existe"));
    await act(async () => { root.render(<Probe path="/p/nunca.png" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1000); });
    expect(readImage).toHaveBeenCalledTimes(1 + PREVIEW_RETRY_DELAYS_MS.length);
    expect(text()).toBe("indisponivel");
  });
});
