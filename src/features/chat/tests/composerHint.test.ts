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
  it("Unknown usa texto neutro; Supported steer e interrupt mantêm suas frases", () => {
    const claudeKey = queueHintKey("claude-code", "send", "unknown", "unsupported");
    const codexKey = queueHintKey("codex", "send", "supported", "unsupported");
    const cursorKey = queueHintKey("cursor", "send", "unsupported", "supported");

    expect(claudeKey).toBe("chat.composer.queueHintUnknown");
    expect(codexKey).toBe("chat.composer.queueHintSteer");
    expect(cursorKey).toBe("chat.composer.queueHintInterrupt");

    // No catálogo pt-BR:
    expect(formatHint(ptBR, codexKey)).toBe("⏎ manda agora, no meio do turno · ⌘⏎ põe na fila");
    expect(formatHint(ptBR, claudeKey)).toBe("⏎ envia agora; o agente pode ler durante ou depois do turno · ⌘⏎ põe na fila");

    // Na inversão (followUpBehavior: "queue"):
    const claudeQueueKey = queueHintKey("claude-code", "queue", "unknown", "unsupported");
    const codexQueueKey = queueHintKey("codex", "queue", "supported", "unsupported");
    expect(formatHint(ptBR, codexQueueKey)).toBe("⏎ põe na fila · ⌘⏎ manda agora, no meio do turno");
    expect(formatHint(ptBR, claudeQueueKey)).toBe("⏎ põe na fila · ⌘⏎ envia agora; o agente pode ler durante ou depois do turno");
  });

  it("os catálogos em en e es também trazem a variante Unknown e o steer do Codex", () => {
    const claudeKey = queueHintKey("claude-code", "send", "unknown", "unsupported");
    const codexKey = queueHintKey("codex", "send", "supported", "unsupported");

    expect(formatHint(en, codexKey)).toBe("⏎ sends now, mid-turn · ⌘⏎ queues it");
    expect(formatHint(en, claudeKey)).toBe("⏎ sends now; the agent may read it during or after the turn · ⌘⏎ queues it");

    expect(formatHint(es, codexKey)).toBe("⏎ envía ahora, en medio del turno · ⌘⏎ lo pone en la cola");
    expect(formatHint(es, claudeKey)).toBe("⏎ lo envía ahora; el agente puede leerlo durante o después del turno · ⌘⏎ lo pone en la cola");
  });
});
