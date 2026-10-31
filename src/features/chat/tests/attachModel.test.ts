import { describe, expect, it } from "vitest";

import {
  addAttachments, attachmentBlock, canSubmit, composerMaxHeight, formatSize, mentionsFor, MAX_ATTACHMENTS, MAX_FILE_BYTES,
  splitAttachmentBlock, type Attachment,
} from "../attachments/attachModel";

const att = (path: string, over: Partial<Attachment> = {}): Attachment => ({
  id: path, path, name: path.split("/").pop()!, kind: "file", mime: null, size: 100, preview: null, temp: false, ...over,
});

describe("juntar anexos", () => {
  it("o mesmo arquivo duas vezes vira um só", () => {
    const r = addAttachments([att("/a/x.png", { kind: "image" })], [att("/a/x.png", { kind: "image" }), att("/a/y.pdf")]);
    expect(r.list.map((a) => a.path)).toEqual(["/a/x.png", "/a/y.pdf"]);
    expect(r.rejected).toEqual([]);
  });

  it("recusa o que passa do número máximo, dizendo por quê, e guarda o resto", () => {
    const current = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => att(`/a/${i}`));
    const r = addAttachments(current, [att("/b/1"), att("/b/2")]);
    expect(r.list).toHaveLength(MAX_ATTACHMENTS);
    expect(r.rejected).toEqual([{ name: "2", reason: "tooMany" }]);
  });

  it("recusa um arquivo acima do limite por arquivo e uma soma acima do limite total", () => {
    const r = addAttachments([], [att("/a/big", { size: MAX_FILE_BYTES + 1 })]);
    expect(r.list).toEqual([]);
    expect(r.rejected).toEqual([{ name: "big", reason: "tooBig" }]);
    const big = MAX_FILE_BYTES - 1;
    const t = addAttachments([att("/a/1", { size: big }), att("/a/2", { size: big })], [att("/a/3", { size: big })]);
    expect(t.rejected).toEqual([{ name: "3", reason: "totalTooBig" }]);
  });

  it("pasta não conta tamanho; um anexo com erro de leitura vira aviso e não entra", () => {
    const r = addAttachments([], [att("/a/dir", { kind: "folder", size: null }), att("/a/ruim", { error: "arquivo não encontrado" })]);
    expect(r.list.map((a) => a.name)).toEqual(["dir"]);
    expect(r.rejected).toEqual([{ name: "ruim", reason: "error", detail: "arquivo não encontrado" }]);
  });

  it("não muda a lista original", () => {
    const base = [att("/a/x")];
    addAttachments(base, [att("/a/y")]);
    expect(base).toHaveLength(1);
  });
});

describe("o bloco [Anexos] que vai no texto (o fallback de todos os motores)", () => {
  const list = [att("/p/captura.png", { kind: "image", size: 340_000 }), att("/p/rel | final.pdf", { size: 2_100_000 }), att("/p/assets", { kind: "folder", size: null })];

  it("lista o caminho de cada anexo, uma linha por anexo", () => {
    const block = attachmentBlock(list);
    expect(block.split("\n")[0]).toBe("[Anexos]");
    expect(block).toContain("- imagem | captura.png | 340000 | /p/captura.png");
    expect(block).toContain("- arquivo | rel ¦ final.pdf | 2100000 | /p/rel | final.pdf");
    expect(block).toContain("- pasta | assets | - | /p/assets");
  });

  it("sem anexos não há bloco", () => {
    expect(attachmentBlock([])).toBe("");
  });

  it("volta ao texto da pessoa e à lista de anexos (para mostrar as miniaturas ao reabrir)", () => {
    const text = `olha isso\n\n${attachmentBlock(list)}`;
    const parsed = splitAttachmentBlock(text);
    expect(parsed.text).toBe("olha isso");
    expect(parsed.attachments).toEqual([
      { kind: "image", name: "captura.png", size: 340000, path: "/p/captura.png" },
      { kind: "file", name: "rel ¦ final.pdf", size: 2100000, path: "/p/rel | final.pdf" },
      { kind: "folder", name: "assets", size: null, path: "/p/assets" },
    ]);
  });

  it("só anexos, sem texto: o texto volta vazio", () => {
    expect(splitAttachmentBlock(attachmentBlock(list)).text).toBe("");
  });

  it("texto sem bloco passa intacto; um [Anexos] no meio da conversa que não é o nosso não é tocado", () => {
    expect(splitAttachmentBlock("oi [Anexos] tchau")).toEqual({ text: "oi [Anexos] tchau", attachments: [] });
    expect(splitAttachmentBlock("[Anexos]\nisso não é lista")).toEqual({ text: "[Anexos]\nisso não é lista", attachments: [] });
  });
});

describe("conversa em TUI recebe os caminhos como o terminal já faz", () => {
  it("@caminho para o Claude, entre aspas se tem espaço; sempre com espaço no fim", () => {
    expect(mentionsFor("claude-code", [att("/p/a b.png"), att("/p/c.pdf")])).toBe('@"/p/a b.png" @/p/c.pdf ');
    expect(mentionsFor("claude-code", [])).toBe("");
  });
});

describe("tamanho e envio", () => {
  it("formata o tamanho", () => {
    expect(formatSize(null)).toBe("");
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(340_000)).toBe("332 KB");
    expect(formatSize(2_100_000)).toBe("2.0 MB");
  });

  it("enviar só com anexos é permitido; sem nada, não; ocupado ou desligado, não", () => {
    expect(canSubmit("  ", 0, false, false)).toBe(false);
    expect(canSubmit("oi", 0, false, false)).toBe(true);
    expect(canSubmit("", 1, false, false)).toBe(true);
    expect(canSubmit("oi", 1, true, false)).toBe(false);
    expect(canSubmit("oi", 1, false, true)).toBe(false);
  });

  it("o bloco do composer cresce até 40% da janela, com um piso", () => {
    expect(composerMaxHeight(1000)).toBe(400);
    expect(composerMaxHeight(300)).toBe(160);
  });
});
