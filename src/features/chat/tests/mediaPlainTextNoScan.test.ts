import { afterEach, describe, expect, it, vi } from "vitest";

import { markdownImages, mentionedMedia } from "../attachments/mediaViewerModel";
import { htmlImagesToMarkdown } from "@/shared/ui/htmlImages";

afterEach(() => { vi.restoreAllMocks(); });

describe("o texto sem marcação de imagem não passa pelas expressões regulares a cada pedaço do streaming", () => {
  it("markdownImages, mentionedMedia e htmlImagesToMarkdown não rodam regex sobre uma fala comum", () => {
    const plain = "Uma resposta comum do agente, sem imagem, sem link e sem código.";
    const exec = vi.spyOn(RegExp.prototype, "exec");
    expect(markdownImages(plain, "/p/ade")).toEqual([]);
    expect(mentionedMedia(plain, "/p/ade")).toEqual([]);
    expect(htmlImagesToMarkdown(plain)).toBe(plain);
    expect(exec).not.toHaveBeenCalled();
  });
});
