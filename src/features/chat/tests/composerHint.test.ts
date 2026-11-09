import { describe, expect, it } from "vitest";

import { queueHintKey } from "../chatModel";
import ptBR from "@/i18n/locales/pt-BR.json";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

function formatHint(catalog: Record<string, string>, key: string, shortcut = "⌘⏎"): string {
  const template = catalog[key];
  if (!template) throw new Error(`Chave ausente: ${key}`);
  return template.replace("{{key}}", shortcut);
}

describe("aviso do composer ao enviar com agente trabalhando (mid-turn hint)", () => {
  it("Claude usa o texto neutro e Codex mantém o texto de steer", () => {
    const claudeKey = queueHintKey("claude-code", "send");
    const codexKey = queueHintKey("codex", "send");
    const cursorKey = queueHintKey("cursor", "send");

    expect(claudeKey).toBe("chat.composer.queueHintClaude");
    expect(codexKey).toBe("chat.composer.queueHintSteer");
    expect(cursorKey).toBe("chat.composer.queueHintInterrupt");

    // No catálogo pt-BR:
    expect(formatHint(ptBR, codexKey)).toBe("⏎ manda agora, no meio do turno · ⌘⏎ põe na fila");
    expect(formatHint(ptBR, claudeKey)).toBe("⏎ vai para o Claude agora; ele a lê no meio ou logo depois do turno · ⌘⏎ põe na fila");

    // Na inversão (followUpBehavior: "queue"):
    const claudeQueueKey = queueHintKey("claude-code", "queue");
    const codexQueueKey = queueHintKey("codex", "queue");
    expect(formatHint(ptBR, codexQueueKey)).toBe("⏎ põe na fila · ⌘⏎ manda agora, no meio do turno");
    expect(formatHint(ptBR, claudeQueueKey)).toBe("⏎ põe na fila · ⌘⏎ vai para o Claude agora; ele a lê no meio ou logo depois do turno");
  });

  it("os catálogos em en e es também trazem a variante neutra do Claude e o steer do Codex", () => {
    const claudeKey = queueHintKey("claude-code", "send");
    const codexKey = queueHintKey("codex", "send");

    expect(formatHint(en, codexKey)).toBe("⏎ sends now, mid-turn · ⌘⏎ queues it");
    expect(formatHint(en, claudeKey)).toBe("⏎ goes to Claude now; it reads it mid-turn or right after the turn · ⌘⏎ queues it");

    expect(formatHint(es, codexKey)).toBe("⏎ envía ahora, en medio del turno · ⌘⏎ lo pone en la cola");
    expect(formatHint(es, claudeKey)).toBe("⏎ va para Claude ahora; lo lee en medio o justo después del turno · ⌘⏎ lo pone en la cola");
  });
});
