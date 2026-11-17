import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { snapshotActivity, turnLive, type Activity } from "./activityModel";
import { useChatLive } from "./liveStore";
import type { ToolKind } from "./timeline/types";
import { usePermissions } from "./permissions/permissionsStore";
import { threadIdOf, type ThreadLive } from "./structured/model";
import { useStructured } from "./structured/store";
import { useDocumentVisible } from "@/shared/useDocumentVisible";

/** O "agora" que avança de segundo em segundo enquanto `active` (o tempo do turno na tela). */
export function useNow(active: boolean, stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const visible = useDocumentVisible();
  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [active, stepMs, visible]);
  return now;
}

export interface LiveSummary {
  working: boolean;
  /** Parado esperando a pessoa (permissão ou pergunta). */
  waiting: boolean;
  startedAt: number | null;
  activity: Activity;
}

/**
 * O resumo ao vivo de uma conversa para a sidebar e o cabeçalho. Conversa por protocolo: os itens
 * que chegam pelo evento do agente. Aba (TUI): o estado do canal (fase, começo do turno e a
 * ferramenta pendente), sem ler a timeline de cada aba.
 */
/** O resumo de uma conversa por protocolo, a partir dos registros dela. Pura. */
function threadSummaryOf(thread: ThreadLive | undefined): LiveSummary {
  const waiting = (thread?.requests.length ?? 0) > 0;
  const working = thread?.phase === "working" || waiting;
  const live = turnLive(thread?.items ?? [], waiting);
  return { working, waiting, startedAt: live.startedAt, activity: live.activity };
}

/** O mesmo resumo em campos primitivos: é o que a linha assina, com igualdade rasa (sem serializar nada). */
interface ThreadSummaryFields {
  working: boolean;
  waiting: boolean;
  startedAt: number | null;
  kind: Activity["kind"];
  tool: string;
  target: string;
}

function threadSummaryFields(thread: ThreadLive | undefined): ThreadSummaryFields {
  const summary = threadSummaryOf(thread);
  const activity = summary.activity;
  return {
    working: summary.working,
    waiting: summary.waiting,
    startedAt: summary.startedAt,
    kind: activity.kind,
    tool: activity.kind === "tool" ? activity.tool : "",
    target: activity.kind === "tool" ? activity.target : "",
  };
}

export function useLiveSummary(key: string): LiveSummary {
  const threadId = threadIdOf(key);
  // Por conversa, a linha assina só os campos primitivos do resumo, com igualdade rasa: o texto que chega numa conversa
  // não a re-renderiza, e nada é serializado no caminho quente (A-custo do seletor).
  const fields = useStructured(useShallow((s) => (threadId ? threadSummaryFields(s.live[threadId]) : null)));
  const phase = useChatLive((s) => s.phase[key]);
  const turn = useChatLive((s) => s.turn[key]);
  const question = useChatLive((s) => !!s.question[key]);
  const awaiting = useChatLive((s) => key in s.awaiting);
  const prompt = usePermissions((s) => s.tui.some((p) => p.tabId === key));
  return useMemo(() => {
    if (threadId && fields) {
      const activity: Activity = fields.kind === "tool"
        ? { kind: "tool", tool: fields.tool as ToolKind, target: fields.target }
        : { kind: fields.kind } as Activity;
      return { working: fields.working, waiting: fields.waiting, startedAt: fields.startedAt, activity };
    }
    const waiting = question || awaiting || prompt;
    const working = phase === "working" || waiting;
    return { working, waiting, startedAt: turn?.startedAt ?? null, activity: snapshotActivity(turn?.tools ?? [], waiting) };
  }, [threadId, fields, phase, turn, question, awaiting, prompt]);
}
