import { beforeEach, describe, expect, it, vi } from "vitest";

const readImage = vi.fn();
vi.mock("@/features/chat/attachments/ipc", () => ({ readImage: (path: string) => readImage(path) }));

import { loadImage, PREVIEW_CACHE_MAX } from "@/features/chat/attachments/useImagePreview";

beforeEach(() => {
  readImage.mockReset();
});

describe("cache das prévias de imagem", () => {
  it("falha_nao_fica_guardada", async () => {
    readImage
      .mockRejectedValueOnce(new Error("o arquivo sumiu"))
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,AA==" });

    expect(await loadImage("/anexos/falha.png")).toBeNull();
    // A falha não vira "indisponível para sempre": a próxima leitura tenta o arquivo de novo.
    expect(await loadImage("/anexos/falha.png")).toBe("data:image/png;base64,AA==");
    expect(readImage).toHaveBeenCalledTimes(2);
  });

  it("cache_tem_limite_e_o_mais_antigo_sai", async () => {
    readImage.mockImplementation(async (path: string) => ({ dataUrl: `data:${path}` }));
    for (let i = 0; i < PREVIEW_CACHE_MAX + 4; i++) await loadImage(`/anexos/img-${i}.png`);

    readImage.mockClear();
    // O primeiro saiu do cache: lê de novo.
    await loadImage("/anexos/img-0.png");
    expect(readImage).toHaveBeenCalledTimes(1);
    // O mais recente segue no cache: não lê de novo.
    await loadImage(`/anexos/img-${PREVIEW_CACHE_MAX + 3}.png`);
    expect(readImage).toHaveBeenCalledTimes(1);
  });
});
