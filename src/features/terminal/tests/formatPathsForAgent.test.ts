import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatPathsForAgent } from "../formatPathsForAgent";

describe("formatPathsForAgent", () => {
  describe("espaços em caminhos", () => {
    it("adiciona aspas duplas com prefixo @ para agentes com suporte a @ quando há espaços", () => {
      const result = formatPathsForAgent("claude-code", ["C:\\Users\\Maria Silva\\foto.png"]);
      expect(result).toBe('@"C:\\Users\\Maria Silva\\foto.png" ');
    });

    it("adiciona aspas simples para codex quando há espaços no caminho", () => {
      const result = formatPathsForAgent("codex", ["C:\\Meu Projeto\\main.rs"]);
      expect(result).toBe("'C:\\Meu Projeto\\main.rs' ");
    });

    it("mantém caminho sem espaços sem aspas para codex", () => {
      const result = formatPathsForAgent("codex", ["src/index.ts"]);
      expect(result).toBe("src/index.ts ");
    });

    it("adiciona aspas simples para agente desconhecido mesmo sem espaços", () => {
      const result = formatPathsForAgent("desconhecido", ["src/index.ts"]);
      expect(result).toBe("'src/index.ts' ");
    });

    it("adiciona aspas simples para agente desconhecido com espaços no caminho", () => {
      const result = formatPathsForAgent("desconhecido", ["C:\\Pasta com espaco\\arquivo.txt"]);
      expect(result).toBe("'C:\\Pasta com espaco\\arquivo.txt' ");
    });
  });

  describe("aspas em caminhos", () => {
    it("escapa aspas duplas dentro de caminho para agentes @", () => {
      const result = formatPathsForAgent("claude-code", ['path/with/"quotes"/file.txt']);
      expect(result).toBe('@"path/with/\\"quotes\\"/file.txt" ');
    });

    it("com apóstrofo, a aba de shell (bash) recebe aspas simples com o apóstrofo escapado como '\\''", () => {
      const result = formatPathsForAgent("bash", ["path/with/'single'/file.txt"]);
      expect(result).toBe(`'path/with/'\\''single'\\''/file.txt' `);
    });

    it("nome com apóstrofo e $() sai como uma palavra só na aba de shell", () => {
      expect(formatPathsForAgent("bash", ["a'$(touch x).txt"])).toBe(`'a'\\''$(touch x).txt' `);
    });

    it("sem agente conhecido, o fallback mantém as aspas de antes (o texto vai a uma TUI, não a um shell)", () => {
      expect(formatPathsForAgent(undefined, ["path/with/'single'/file.txt"])).toBe(`"path/with/'single'/file.txt" `);
      expect(formatPathsForAgent("meu-agente", ["a'b.txt"])).toBe(`"a'b.txt" `);
    });

    it.runIf(process.platform !== "win32")("o sh lê o caminho com apóstrofo e $() como texto, sem executar nada", () => {
      const quoted = formatPathsForAgent("bash", ["a'$(printf pwned).txt"]).trim();
      const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
      expect(out).toBe("a'$(printf pwned).txt");
    });

    it("codex com apóstrofo também usa aspas duplas", () => {
      const result = formatPathsForAgent("codex", ["C:\\Users\\D'Ávila\\foto.png"]);
      expect(result).toBe(`"C:\\Users\\D'Ávila\\foto.png" `);
    });
  });

  describe("vários arquivos", () => {
    it("separa múltiplos arquivos por espaço e termina com espaço", () => {
      const paths = ["/tmp/a.png", "/tmp/b com espaco.png", "/tmp/c.txt"];
      const result = formatPathsForAgent("claude-code", paths);
      expect(result).toBe('@/tmp/a.png @"/tmp/b com espaco.png" @/tmp/c.txt ');
    });

    it("formata múltiplos arquivos para codex", () => {
      const paths = ["src/a.ts", "src/b com espaco.ts"];
      const result = formatPathsForAgent("codex", paths);
      expect(result).toBe("src/a.ts 'src/b com espaco.ts' ");
    });

    it("formata múltiplos arquivos para agente desconhecido", () => {
      const paths = ["a.txt", "b.txt"];
      const result = formatPathsForAgent("antigravity", paths);
      expect(result).toBe("'a.txt' 'b.txt' ");
    });
  });

  describe("agente desconhecido ou indefinido", () => {
    it("formata com aspas simples sem prefixo quando agentId é undefined", () => {
      const result = formatPathsForAgent(undefined, ["/home/user/doc.pdf"]);
      expect(result).toBe("'/home/user/doc.pdf' ");
    });

    it("formata com aspas simples sem prefixo para agente não catalogado", () => {
      const result = formatPathsForAgent("outro-agente", ["/var/log/syslog"]);
      expect(result).toBe("'/var/log/syslog' ");
    });

    it("formata com aspas simples sem prefixo para antigravity (não verificado com prefixo)", () => {
      const result = formatPathsForAgent("antigravity", ["src/main.rs"]);
      expect(result).toBe("'src/main.rs' ");
    });
  });

  describe("agentes com sintaxe @ verificada", () => {
    it("formata gemini-cli com prefixo @", () => {
      const result = formatPathsForAgent("gemini-cli", ["photo.jpg"]);
      expect(result).toBe("@photo.jpg ");
    });

    it("formata opencode com prefixo @", () => {
      const result = formatPathsForAgent("opencode", ["diagram.webp"]);
      expect(result).toBe("@diagram.webp ");
    });
  });

  describe("casos de borda e sanitização", () => {
    it("retorna string vazia para lista de caminhos vazia", () => {
      expect(formatPathsForAgent("claude-code", [])).toBe("");
    });

    it("ignora strings vazias na lista de caminhos", () => {
      expect(formatPathsForAgent("claude-code", ["", ""])).toBe("");
    });

    it("substitui quebras de linha dentro do caminho por espaços (nunca envia Enter)", () => {
      const result = formatPathsForAgent("claude-code", ["linha1\nlinha2.png\r\n"]);
      expect(result).not.toContain("\n");
      expect(result).not.toContain("\r");
      expect(result).toBe('@"linha1 linha2.png " ');
    });
  });
});
