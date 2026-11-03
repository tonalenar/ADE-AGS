import type { StructuredSnapshot } from "@/features/terminal/structuredState";

/**
 * Dois sinais que o canal estruturado (o transcript do Claude Code e do Codex, ver `src-tauri/src/canal`) já
 * calcula e o Vigia só lê:
 * - chamada repetida: a mesma ferramenta com os mesmos argumentos 3, 5 e 8 vezes desde a última mensagem da
 *   pessoa (`canal::repeat`). É o laço "mesma ferramenta sem progresso", que a tela não denuncia;
 * - contexto quase cheio: a conversa passou de ~80% da janela do modelo (`canal::context`), perto do
 *   auto-compact, quando o integrante começa a esquecer o que fez.
 * Tudo aqui é puro; o relógio, o estado e o envio vêm do Vigia.
 */

/** Acima disto (fração da janela) o Vigia avisa. O mesmo valor de `canal::context::WARN_PRESSURE`. */
export const CONTEXT_WARN = 0.8;
/** O mesmo terminal só é avisado de novo do contexto depois disto. */
export const CONTEXT_REPORT_MS = 60 * 60_000;
/** Caracteres por token na estimativa do que veio depois do último `usage` real (como no backend). */
const CHARS_PER_TOKEN = 4;

/** A fração da janela ocupada, ou `null` se não se sabe (sem medidor, sem janela). Pura. */
export function contextPressure(snapshot: StructuredSnapshot | undefined): number | null {
  const meter = snapshot?.context;
  if (!meter || !meter.windowTokens) return null;
  const used = meter.anchorTokens + Math.ceil(meter.extraChars / CHARS_PER_TOKEN);
  return used / meter.windowTokens;
}

/** A chave de um degrau de repetição: o mesmo degrau da mesma chamada no mesmo turno avisa uma vez. Pura. */
export function repeatKey(tabId: string, snapshot: StructuredSnapshot | undefined): string | null {
  const r = snapshot?.repeat;
  if (!r) return null;
  return `${tabId}:${snapshot?.turnStartedAt ?? 0}:${r.key}:${r.step}`;
}

/** O aviso do chat de uma chamada repetida. Pura. */
export function repeatStuck(name: string, snapshot: StructuredSnapshot): string {
  const r = snapshot.repeat!;
  const call = r.summary.trim() ? `${r.name} ${r.summary}` : r.name;
  return `${name} chamou ${r.count} vezes a mesma ferramenta com os mesmos argumentos ("${call}") desde a última mensagem, sem progresso visível.`;
}

export const REPEAT_DONE = "só avisei, não interrompi o agente nem escrevi no terminal dele.";

/** Avisa do contexto agora? Acima do limiar e sem aviso na última hora para o mesmo terminal. Pura. */
export function contextDue(pressure: number | null, lastReport: number | undefined, now: number): boolean {
  return pressure !== null && pressure >= CONTEXT_WARN && (lastReport === undefined || now - lastReport >= CONTEXT_REPORT_MS);
}

/** O aviso do chat do contexto quase cheio. Pura. */
export function contextStuck(name: string, pressure: number): string {
  return `${name} está com ~${Math.round(pressure * 100)}% da janela de contexto: perto do auto-compact, pode esquecer detalhes do que fez.`;
}

/** A cutucada ao Orquestrador: pedir o estado antes de o integrante esquecer. Pura. */
export function contextNudge(name: string, pressure: number): string {
  return `${name} está com ~${Math.round(pressure * 100)}% da janela de contexto. Se a tarefa dele é longa, peça agora um resumo do estado (arquivos, erros, próximo passo) ou um handoff, com ags peer ask "${name}" "…".`;
}
