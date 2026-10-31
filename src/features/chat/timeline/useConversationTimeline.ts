import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { structuredOf, type StructuredPhase } from "@/features/terminal/structuredState";

import { conversationTimeline } from "../ipc";
import type { Timeline } from "./types";

interface State {
  timeline: Timeline | null;
  /** Já houve uma resposta do backend (com ou sem canal). */
  loaded: boolean;
  phase: StructuredPhase | null;
}

/**
 * A timeline de uma aba, ao vivo: lê uma vez e relê quando o backend avisa que o transcript cresceu
 * (`cc-conversation-grew`) ou que o canal da aba mudou (`cc-structured-state`, que também diz se o
 * agente está trabalhando). Nunca dois pedidos ao mesmo tempo: um aviso no meio de uma leitura
 * pede mais uma, no fim.
 */
export function useConversationTimeline(tabId: string): State {
  const [state, setState] = useState<State>(() => ({ timeline: null, loaded: false, phase: structuredOf(tabId)?.phase ?? null }));
  const inFlight = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (inFlight.current) {
        again.current = true;
        return;
      }
      inFlight.current = true;
      conversationTimeline(tabId)
        .then((timeline) => { if (alive) setState((s) => ({ ...s, timeline, loaded: true })); })
        .catch(() => { if (alive) setState((s) => ({ ...s, loaded: true })); })
        .finally(() => {
          inFlight.current = false;
          if (alive && again.current) {
            again.current = false;
            load();
          }
        });
    };
    load();
    const offGrew = listen<{ tabId: string }>("cc-conversation-grew", (e) => { if (e.payload.tabId === tabId) load(); });
    const offState = listen<{ tabId: string; phase?: StructuredPhase; removed?: boolean }>("cc-structured-state", (e) => {
      if (e.payload.tabId !== tabId) return;
      setState((s) => ({ ...s, phase: e.payload.removed ? null : e.payload.phase ?? null }));
      load();
    });
    return () => {
      alive = false;
      offGrew.then((fn) => fn()).catch(() => undefined);
      offState.then((fn) => fn()).catch(() => undefined);
    };
  }, [tabId]);

  return state;
}
