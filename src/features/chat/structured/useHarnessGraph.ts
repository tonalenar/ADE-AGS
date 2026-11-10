import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { listHarnessExecutionGraph } from "@/features/runs/ipc";

import { applyGraphResponse, shouldSync, type GraphState } from "./harnessTreeModel";

export interface HarnessGraphScope {
  /** Conversas da linhagem (a raiz, as filhas da projeção e as da store). */
  threadIds: ReadonlySet<string>;
  /** Tarefas da Frota que a árvore já conhece. */
  taskIds: ReadonlySet<string>;
}

/**
 * A árvore do harness de uma conversa, mantida por evento e por cursor (Fase 6). Não há timer nem polling.
 *
 * - A carga inicial pede a árvore inteira (`afterCursor = null`).
 * - `cc-harness-event` leva `{ threadId, cursor }`: só uma conversa da linhagem com cursor além do aplicado
 *   dispara uma leitura, e a leitura pede o delta a partir do cursor aplicado.
 * - `cc-task-changed` e `cc-thread-run-changed` mudam o estado dos nós sem passar pelo log: uma leitura, que
 *   volta com os nós atuais e, normalmente, nenhum evento novo.
 * - Só há uma leitura em voo. O que chega durante ela vira, no máximo, uma leitura depois, com o cursor então
 *   aplicado, e só se ainda houver algo além dele (um aviso que a própria leitura já cobriu não repete).
 */
export function useHarnessGraph(threadId: string, getScope: () => HarnessGraphScope): GraphState | null {
  const [state, setState] = useState<GraphState | null>(null);
  const scopeOf = useRef(getScope);
  scopeOf.current = getScope;

  useEffect(() => {
    let alive = true;
    let inflight = false;
    /** O maior cursor pedido durante a leitura em voo; `Infinity` para o que não traz cursor (estado de tarefa). */
    let wanted: number | null = null;
    let current: GraphState | null = null;
    setState(null);

    const sync = (cursor: number = Number.POSITIVE_INFINITY) => {
      if (inflight) {
        wanted = Math.max(wanted ?? Number.NEGATIVE_INFINITY, cursor);
        return;
      }
      inflight = true;
      wanted = null;
      void listHarnessExecutionGraph(threadId, current?.cursor ?? null)
        .then((next) => {
          if (!alive) return;
          current = applyGraphResponse(current, next);
          setState(current);
        })
        .catch(() => undefined)
        .finally(() => {
          inflight = false;
          if (alive && wanted !== null && wanted > (current?.cursor ?? -1)) sync(wanted);
        });
    };

    const unlisten = [
      listen<unknown>("cc-harness-event", (event) => {
        if (!shouldSync(event.payload, scopeOf.current().threadIds, current?.cursor ?? null)) return;
        sync((event.payload as { cursor: number }).cursor);
      }),
      listen<string>("cc-task-changed", (event) => {
        if (scopeOf.current().taskIds.has(event.payload)) sync();
      }),
      listen<string>("cc-thread-run-changed", (event) => {
        if (scopeOf.current().threadIds.has(event.payload)) sync();
      }),
    ];
    sync();
    return () => {
      alive = false;
      unlisten.forEach((pending) => pending.then((off) => off()).catch(() => undefined));
    };
  }, [threadId]);

  return state;
}
