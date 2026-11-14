import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost/${path}` }));

import { captureVideoFrame, commentFromSelection, commentsForMessage, filterMedia, markdownImages, mentionedMedia, nextMediaIndex, resizeDimensions, undoStroke, type ConversationMedia } from "../attachments/mediaViewerModel";
import { isVideoFile, videoMediaSrc } from "../attachments/videoMedia";
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

  it("transforma arrasto em região numerada e preserva suas coordenadas no contexto", () => {
    const comment = commentFromSelection({ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 }, "Revisar trecho");
    expect(comment.x).toBeCloseTo(0.25);
    expect(comment.y).toBeCloseTo(0.4);
    expect(comment.region?.x).toBeCloseTo(0.1);
    expect(comment.region?.y).toBeCloseTo(0.2);
    expect(comment.region?.width).toBeCloseTo(0.3);
    expect(comment.region?.height).toBeCloseTo(0.4);
    expect(commentsForMessage([comment])).toContain("região 10%, 20%–40%, 60%");
  });

  it("desfaz a última marcação", () => {
    expect(undoStroke([[[0, 0], [1, 1]], [[0.2, 0.2]]].map((stroke) => stroke.map(([x, y]) => ({ x, y })))).strokes).toHaveLength(1);
  });

  it("captura um quadro do vídeo como imagem", () => {
    expect(captureVideoFrame(media[1]!, "data:image/png;base64,abc")).toMatchObject({
      kind: "image", name: "b.png", preview: "data:image/png;base64,abc",
    });
  });

  it("coleta imagens locais de Markdown da conversa, mas ignora URLs e caminhos fora do projeto", () => {
    const images = markdownImages([
      "![captura](/repo/screens/captura.png)",
      "![relativa](assets/segunda.webp)",
      "![remota](https://exemplo.invalid/terceira.png)",
      "![fora](/Users/tonalencar/privada.png)",
      "```md\n![código](/repo/nao-carregar.png)\n```",
    ].join("\n"), "/repo");
    expect(images.map((image) => image.path)).toEqual(["/repo/screens/captura.png", "/repo/assets/segunda.webp"]);
  });

  it("mantém imagens data URL no visualizador sem fazer requisição externa", () => {
    const source = "data:image/png;base64,aGVsbG8=";
    expect(markdownImages(`![gerada](${source})`, null)).toMatchObject([{ path: source, preview: source, name: "gerada.png" }]);
  });

  it("detecta extensões de vídeo e converte URIs file:// para URL reproduzível", () => {
    expect(isVideoFile("/tmp/gravacao.MOV")).toBe(true);
    expect(isVideoFile("foto.png")).toBe(false);
    expect(videoMediaSrc("file:///Users/teste/meu%20video.mp4")).toBe("/Users/teste/meu video.mp4");
    expect(videoMediaSrc("asset://localhost/demo.mp4")).toBe("asset://localhost/demo.mp4");
    expect(videoMediaSrc("https://exemplo.invalid/demo.webm")).toBe("https://exemplo.invalid/demo.webm");
  });

  it("extrai vídeos citados no Markdown da conversa dentro da pasta", () => {
    const items = mentionedMedia("Confira `clips/demo.mov`, [tela](clips/a.png) e `../../fora.mp4`.", "/repo");
    expect(items).toEqual([
      { path: "/repo/clips/a.png", name: "a.png", kind: "image", preview: null },
      { path: "/repo/clips/demo.mov", name: "demo.mov", kind: "video", preview: null },
    ]);
  });
});
