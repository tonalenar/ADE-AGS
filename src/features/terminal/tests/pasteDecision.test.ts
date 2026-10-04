import { describe, expect, it } from "vitest";
import { decidePaste, MAX_IMAGE_BYTES, PASTE_IMAGE_TYPES } from "../pasteDecision";

describe("decidePaste", () => {
  describe("tipos de imagem suportados", () => {
    it.each(PASTE_IMAGE_TYPES)("aceita o tipo de imagem suportado: %s", (mime) => {
      const items = [{ kind: "file", type: mime, size: 1024 }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "image", index: 0 });
    });

    it("aceita mime types padrão em minúsculas", () => {
      const items = [{ kind: "file", type: "image/png", size: 1024 }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "image", index: 0 });
    });

    it("identifica o índice correto quando a imagem válida não é o primeiro item", () => {
      const items = [
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/bmp", size: 500 }, // não suportado
        { kind: "file", type: "image/png", size: 2000 }, // válido
      ];
      const decision = decidePaste(items, "texto fallback");
      expect(decision).toEqual({ action: "image", index: 2 });
    });
  });

  describe("limite de tamanho de 20 MB", () => {
    it("aceita imagem no limite exato de 20 MB", () => {
      const items = [{ kind: "file", type: "image/png", size: MAX_IMAGE_BYTES }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "image", index: 0 });
    });

    it("rejeita imagem com mais de 20 MB se não houver texto na área de transferência", () => {
      const items = [{ kind: "file", type: "image/png", size: MAX_IMAGE_BYTES + 1 }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "reject", reason: "size" });
    });

    it("faz fallback para texto se a imagem exceder 20 MB e houver texto", () => {
      const items = [{ kind: "file", type: "image/png", size: MAX_IMAGE_BYTES + 100 }];
      const decision = decidePaste(items, "texto alternativo");
      expect(decision).toEqual({ action: "text" });
    });

    it("aceita imagem quando size não está definido no item", () => {
      const items = [{ kind: "file", type: "image/jpeg" }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "image", index: 0 });
    });
  });

  describe("tipos de imagem não suportados", () => {
    it("rejeita imagem não suportada (ex: image/bmp) quando não há texto", () => {
      const items = [{ kind: "file", type: "image/bmp", size: 500 }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "reject", reason: "type" });
    });

    it("rejeita imagem svg quando não há texto", () => {
      const items = [{ kind: "file", type: "image/svg+xml", size: 500 }];
      const decision = decidePaste(items, "");
      expect(decision).toEqual({ action: "reject", reason: "type" });
    });

    it("faz fallback para texto se o tipo de imagem for não suportado mas houver texto", () => {
      const items = [{ kind: "file", type: "image/tiff", size: 1000 }];
      const decision = decidePaste(items, "meu comando ou texto");
      expect(decision).toEqual({ action: "text" });
    });
  });

  describe("decisão entre imagem e texto", () => {
    it("imagem válida tem prioridade sobre texto presente", () => {
      const items = [{ kind: "file", type: "image/png", size: 5000 }];
      const decision = decidePaste(items, "comando no clipboard");
      expect(decision).toEqual({ action: "image", index: 0 });
    });

    it("retorna texto quando apenas texto está na área de transferência", () => {
      const items = [{ kind: "string", type: "text/plain" }];
      const decision = decidePaste(items, "git status");
      expect(decision).toEqual({ action: "text" });
    });

    it("retorna texto quando items está vazio mas há texto", () => {
      const decision = decidePaste([], "ls -la");
      expect(decision).toEqual({ action: "text" });
    });

    it("retorna texto mesmo sem texto e sem rejeições de imagem (comportamento padrão seguro)", () => {
      const decision = decidePaste([], "");
      expect(decision).toEqual({ action: "text" });
    });

    it("ignora arquivos que não sejam de tipo image/*", () => {
      const items = [{ kind: "file", type: "application/pdf", size: 1000 }];
      const decision = decidePaste(items, "conteúdo colado");
      expect(decision).toEqual({ action: "text" });
    });
  });
});
