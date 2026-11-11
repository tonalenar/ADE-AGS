import type { StructuredPhase } from "@/features/terminal/structuredState";
import { threadIdOf, type ThreadLive } from "@/features/chat/structured/model";

/**
 * Os avisos no app (toast) quando outra conversa termina, falha ou pede a sua vez, com a janela em
 * foco. Aqui fica a conta: o estado de cada conversa e o que virou entre dois estados. O ouvinte e o
 * toast estão em `InAppNotices.tsx`. Com a janela em segundo plano quem avisa é o sistema
 * (`notifier.rs`), e só para missões e aprovações da frota.
 */

/** O que o aviso precisa saber de uma conversa em um instante. */
export interface NoticeState {
  phase: StructuredPhase;
  /** Há um diálogo de aprovação na tela. */
  awaiting: boolean;
  /** A conversa tem uma pergunta em aberto, esperando a sua resposta. */
  question: boolean;
  /** O último turno falhou. */
  failed: boolean;
}

export type NoticeKind = "approval" | "question" | "failed" | "done";

export interface ConversationNotice {
  ref: string;
  kind: NoticeKind;
}

/**
 * O estado de cada conversa, pela chave (`tab.id` ou `thread:<id>`). Conversa por protocolo: a fase, os
 * pedidos pendentes e o erro do próprio hilo. Conversa de aba (TUI): a fase, a pergunta e o diálogo de
 * aprovação do canal. Conversa sem estado ao vivo ainda fica de fora. Pura.
 */
export function noticeStatesOf(
  refs: readonly string[],
  live: { phase: Record<string, StructuredPhase>; question: Record<string, boolean>; awaiting: Record<string, string> },
  threads: Record<string, ThreadLive>,
): Record<string, NoticeState> {
  const out: Record<string, NoticeState> = {};
  for (const ref of refs) {
    const thread = threadIdOf(ref);
    if (thread) {
      const hilo = threads[thread];
      if (!hilo) continue;
      out[ref] = {
        phase: hilo.phase,
        awaiting: hilo.requests.some((r) => r.state === "pending" && r.kind !== "question"),
        question: hilo.requests.some((r) => r.state === "pending" && r.kind === "question"),
        failed: hilo.error !== null,
      };
    } else {
      out[ref] = {
        phase: live.phase[ref] ?? "unknown",
        awaiting: ref in live.awaiting,
        question: live.question[ref] === true,
        failed: false,
      };
    }
  }
  return out;
}

/**
 * Os avisos do passo: só o que virou (transição), nunca o que já estava assim. A conversa à vista fica
 * de fora (quem olha já sabe), e uma conversa que aparece pela primeira vez entra sem aviso. Cada
 * conversa recebe no máximo um aviso, o mais urgente: aprovação, pergunta, falha, depois "terminou".
 * Pura.
 */
export function noticesBetween(
  before: Readonly<Record<string, NoticeState>>,
  after: Readonly<Record<string, NoticeState>>,
  selectedRef: string | null,
): ConversationNotice[] {
  const out: ConversationNotice[] = [];
  for (const [ref, now] of Object.entries(after)) {
    if (ref === selectedRef) continue;
    const prev = before[ref];
    if (!prev) continue;
    const kind = noticeKind(prev, now);
    if (kind) out.push({ ref, kind });
  }
  return out;
}

function noticeKind(prev: NoticeState, now: NoticeState): NoticeKind | null {
  if (!prev.awaiting && now.awaiting) return "approval";
  if (!prev.question && now.question) return "question";
  if (!prev.failed && now.failed) return "failed";
  // Um turno que acabou com falha já avisou como "falhou": não repete como "terminou". "unknown" pode
  // ser só estado velho do canal, então não conta como fim de turno: só working → idle avisa.
  if (prev.phase === "working" && now.phase === "idle" && !now.failed) return "done";
  return null;
}
