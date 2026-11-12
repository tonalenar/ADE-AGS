import { describe, expect, it } from "vitest";

import { captureVideoFrame, commentsForMessage, filterMedia, nextMediaIndex, resizeDimensions, undoStroke, type ConversationMedia } from "../attachments/mediaViewerModel";
import { setImageContext } from "../attachments/imageContext";
import { threadMessage } from "../attachments/send";

const media: ConversationMedia[] = [
  { path: "/a.png", name: "a.png", kind: "image", preview: null },
  { path: "/b.mp4", name: "b.mp4", kind: "video", preview: null },
  { path: "/c.png", name: "c.png", kind: "image", preview: null },
];

describe("modelo do visualizador de mídia", () => {
  it("filtra imagem, vídeo e tudo, e navega pela lista resultante", () => {
    expect(filterMedia(media, "image").map((item) => item.path)).toEqual(["/a.png", "/c.png"]);
    expect(filterMedia(media, "video").map((item) => item.path)).toEqual(["/b.mp4"]);
    expect(nextMediaIndex(0, 1, 2)).toBe(1);
  });

  it("mantém proporção ao redimensionar por largura ou altura", () => {
    expect(resizeDimensions(1600, 900, { width: 800 })).toEqual({ width: 800, height: 450 });
    expect(resizeDimensions(1600, 900, { height: 450 })).toEqual({ width: 800, height: 450 });
  });

  it("enumera comentários e envia suas coordenadas como contexto", () => {
    const comments = [{ x: 0.2, y: 0.6, text: "Olhar aqui" }];
    expect(commentsForMessage(comments)).toBe("1. Olhar aqui (20%, 60%)");
    setImageContext("/a.png", comments);
    const sent = threadMessage("Veja este ponto", [{ id: "a", path: "/a.png", name: "a.png", kind: "image", mime: "image/png", size: 10, preview: null, temp: false }]);
    expect(sent.text).toContain("1. Olhar aqui (20%, 60%)");
    expect(sent.images).toEqual(["/a.png"]);
  });

  it("desfaz a última marcação", () => {
    expect(undoStroke([[[0, 0], [1, 1]], [[0.2, 0.2]]].map((stroke) => stroke.map(([x, y]) => ({ x, y })))).strokes).toHaveLength(1);
  });

  it("captura um quadro do vídeo como imagem", () => {
    expect(captureVideoFrame(media[1]!, "data:image/png;base64,abc")).toMatchObject({
      kind: "image", name: "b.png", preview: "data:image/png;base64,abc",
    });
  });
});
