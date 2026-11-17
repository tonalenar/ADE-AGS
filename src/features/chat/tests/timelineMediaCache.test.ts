import { beforeEach, describe, expect, it, vi } from "vitest";

// A conta das imagens por item é espiada: num quadro novo, só o item que mudou pode ser lido de novo.
vi.mock("@/shared/ui/htmlImages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/htmlImages")>();
  return { ...actual, htmlImagesToMarkdown: vi.fn(actual.htmlImagesToMarkdown) };
});

import { htmlImagesToMarkdown } from "@/shared/ui/htmlImages";
import { mediaOfItems } from "../timeline/mediaCache";
import type { TimelineItem } from "../timeline/types";

const foto = (id: string, src: string): TimelineItem => ({ kind: "assistant", id, text: `![${id}](data:image/png;base64,${src})` });

beforeEach(() => { vi.mocked(htmlImagesToMarkdown).mockClear(); });

describe("as imagens citadas pela conversa são contadas uma vez por item (A107)", () => {
  it("so_o_item_que_mudou_e_relido: um pedaço no fim não relê as imagens dos outros itens", () => {
    const items = Array.from({ length: 30 }, (_, i) => foto(`a${i}`, `AAAA${i}`));
    expect(mediaOfItems(items, "/p")).toHaveLength(30);
    vi.mocked(htmlImagesToMarkdown).mockClear();

    const streamed = [...items.slice(0, 29), foto("a29", "BBBB")];
    const media = mediaOfItems(streamed, "/p");
    expect(media).toHaveLength(30);
    expect(htmlImagesToMarkdown).toHaveBeenCalledTimes(1);
  });

  it("repete a mesma imagem só uma vez, como antes", () => {
    const items = [foto("a", "SAME"), foto("b", "SAME"), foto("c", "OTHER")];
    expect(mediaOfItems(items, null).map((m) => m.name)).toEqual(["a.png", "c.png"]);
  });
});
