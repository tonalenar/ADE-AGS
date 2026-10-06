import { describe, expect, it } from "vitest";
import { promptText, segmentResponses } from "../responseSegments";

describe("responseSegments - QA Suite Completa para TUIs de Agentes", () => {
  describe("Claude Code (marcadores ● e ⏺)", () => {
    it("reconhece marcador ● padrão e agrupa chamadas de ferramentas na mesma resposta", () => {
      const buffer = [
        "> investigue o bug de memoria",
        "",
        "● Entendido. Vou verificar o modulo review.ts.",
        "",
        "● Read(src/features/memory/review.ts)",
        "  ⎿  Read 45 lines",
        "",
        "● Edit(src/features/memory/bulkReview.ts)",
        "  ⎿  Wrote 80 lines",
        "",
        "● Bash(cargo test --lib notifier)",
        "  ⎿  6 tests passed",
        "",
        "● Conclui todas as correcoes com sucesso.",
        "  Os testes estao 100% verdes.",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      const seg = segments[0];
      expect(seg.index).toBe(0);
      expect(seg.prompt).toBe("investigue o bug de memoria");
      expect(seg.marker).toBe("●");
      expect(seg.startLine).toBe(2);
      expect(seg.endLine).toBe(14);
      expect(seg.text).toContain("Entendido. Vou verificar o modulo review.ts.");
      expect(seg.text).toContain("● Read(src/features/memory/review.ts)");
      expect(seg.text).toContain("● Edit(src/features/memory/bulkReview.ts)");
      expect(seg.text).toContain("● Bash(cargo test --lib notifier)");
      expect(seg.text).toContain("Conclui todas as correcoes com sucesso.");
    });

    it("reconhece marcador alternativo ⏺ do Claude Code", () => {
      const buffer = [
        "> execute os testes unitarios",
        "⏺ Executando vitest nos componentes de chat...",
        "  Resultados: 12 testes passaram.",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      expect(segments[0].marker).toBe("⏺");
      expect(segments[0].prompt).toBe("execute os testes unitarios");
      expect(segments[0].text).toBe("Executando vitest nos componentes de chat...\nResultados: 12 testes passaram.");
    });
  });

  describe("Codex (marcador • e prompt ›)", () => {
    it("reconhece prompt › e marcador • com quebra e dedentacao de paragrafos", () => {
      const buffer = [
        "› refatore a funcao de notificacoes",
        "",
        "• Modifiquei o arquivo notifier.rs para usar AUMID estavel.",
        "  Tambem adicionei suporte a cliques no Windows.",
        "",
        "› envie o commit",
        "",
        "• Commit realizado com mensagem fix(notifications).",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(2);

      expect(segments[0].marker).toBe("•");
      expect(segments[0].prompt).toBe("refatore a funcao de notificacoes");
      expect(segments[0].text).toBe(
        "Modifiquei o arquivo notifier.rs para usar AUMID estavel.\nTambem adicionei suporte a cliques no Windows."
      );

      expect(segments[1].marker).toBe("•");
      expect(segments[1].prompt).toBe("envie o commit");
      expect(segments[1].text).toBe("Commit realizado com mensagem fix(notifications).");
    });
  });

  describe("Gemini CLI (marcador ✦ e caixas de entrada)", () => {
    it("reconhece prompt dentro de borda de caixa (│ >) e marcador ✦", () => {
      const buffer = [
        "╭──────────────────────────╮",
        "│ > analise a acessibilidade │",
        "╰──────────────────────────╯",
        "",
        "✦ A acessibilidade de teclado exige tratamento de Esc e Enter.",
        "  Todos os modais devem possuir aria-modal=\"true\".",
        "╭──────────────────────────╮",
        "│ >                        │",
        "╰──────────────────────────╯",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      expect(segments[0].marker).toBe("✦");
      expect(segments[0].prompt).toBe("analise a acessibilidade");
      expect(segments[0].text).toBe(
        "A acessibilidade de teclado exige tratamento de Esc e Enter.\nTodos os modais devem possuir aria-modal=\"true\"."
      );
    });
  });

  describe("Antigravity (marcadores ◆ e ◇ e prompt ❯)", () => {
    it("reconhece prompt ❯ e marcadores ◆ (preenchido) e ◇ (vazado)", () => {
      const buffer = [
        "❯ gere o plano de QA para a Etapa 20",
        "",
        "◆ Iniciando analise dos requisitos do plano de testes...",
        "  Passo 1: Validar regressao do modo Canvas.",
        "",
        "◇ Subetapa de verificacao de memoria iniciada.",
        "  Garantindo que contradicoes nao sejam aprovadas sem aviso.",
        "",
        "❯ execute o vitest",
        "",
        "◆ Vitest executado: 1311 testes passaram sem falhas.",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(2);

      expect(segments[0].marker).toBe("◆");
      expect(segments[0].prompt).toBe("gere o plano de QA para a Etapa 20");
      expect(segments[0].text).toContain("Iniciando analise dos requisitos do plano de testes...");
      expect(segments[0].text).toContain("◇ Subetapa de verificacao de memoria iniciada.");

      expect(segments[1].marker).toBe("◆");
      expect(segments[1].prompt).toBe("execute o vitest");
      expect(segments[1].text).toBe("Vitest executado: 1311 testes passaram sem falhas.");
    });
  });

  describe("Casos de Borda e Robustez", () => {
    it("linhas com bordas decorativas (───, ━━━, ═══, ╭, ╰, ┌, └) fecham a resposta e sao ignoradas", () => {
      const buffer = [
        "> status",
        "● Tudo ok.",
        "─────────────────────────────",
        "╭───────────────────────────╮",
        "│ caixa seguinte            │",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      expect(segments[0].text).toBe("Tudo ok.");
    });

    it("prompt sem resposta (agente ainda processando ou usuario apenas digitou) nao cria segmento fantasma", () => {
      const buffer = [
        "> comando anterior",
        "● Resposta anterior.",
        "> novo comando pendente",
        "",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      expect(segments[0].prompt).toBe("comando anterior");
      expect(segments[0].text).toBe("Resposta anterior.");
    });

    it("resposta cujo prompt rolou para fora do scrollback tem prompt null", () => {
      const buffer = [
        "● Resposta cujo prompt ja saiu do topo do buffer.",
        "  Linha adicional da resposta.",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      expect(segments[0].prompt).toBeNull();
      expect(segments[0].marker).toBe("●");
      expect(segments[0].text).toBe("Resposta cujo prompt ja saiu do topo do buffer.\nLinha adicional da resposta.");
    });

    it("citacoes com > indentadas dentro do texto de resposta nao sao tratadas como novo prompt", () => {
      const buffer = [
        "> explique o trecho citado",
        "● Analisando o trecho:",
        "  > esta e uma citacao de codigo que nao deve virar prompt",
        "  Continuacao da explicacao apos a citacao.",
      ];

      const segments = segmentResponses(buffer);
      expect(segments).toHaveLength(1);
      expect(segments[0].prompt).toBe("explique o trecho citado");
      expect(segments[0].text).toContain("> esta e uma citacao de codigo que nao deve virar prompt");
      expect(segments[0].text).toContain("Continuacao da explicacao apos a citacao.");
    });

    it("promptText detecta prefixos >, › e ❯ apenas na coluna 0 ou dentro de │ >", () => {
      expect(promptText("> inicio")).toBe("inicio");
      expect(promptText("› inicio")).toBe("inicio");
      expect(promptText("❯ inicio")).toBe("inicio");
      expect(promptText("│ > inicio")).toBe("inicio");
      expect(promptText("  > indentado")).toBeNull();
      expect(promptText("texto comum")).toBeNull();
      expect(promptText(">")).toBeNull();
    });
  });
});
