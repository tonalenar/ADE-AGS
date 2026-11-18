import { useCallback, useEffect, useRef, useState } from "react";

import { designApi, onDesignChanged, type Design, type DesignDetail } from "./designApi";
import { designsForBoardDetails, freshDesigns } from "./scope";

export interface DesignScope { cwd: string | null; missionId: string | null }

/**
 * Os designs do canvas atual (com páginas, pranchetas e comentários), sempre em dia com o que o agente
 * faz (evento `design-changed`). Quando aparece um design NOVO depois da primeira carga, guarda o aviso
 * (`notice`) e marca `unseen` até o usuário abrir: nunca abre nada sozinho.
 */
export function useScopedDesigns(scope: DesignScope) {
  const [details, setDetails] = useState<DesignDetail[]>([]);
  const [notice, setNotice] = useState<Design | null>(null);
  const [unseen, setUnseen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  const seq = useRef(0);
  const scopeKey = `${scope.missionId ?? ""}|${scope.cwd ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const full = designsForBoardDetails(await designApi.listDetails(), scopeRef.current);
      if (mine !== seq.current) return;
      setDetails(full);
      const list = full.map((d) => d.design);
      if (known.current) {
        const fresh = freshDesigns(known.current, list);
        if (fresh.length > 0) {
          setNotice(fresh[fresh.length - 1]);
          setUnseen(true);
        }
      }
      known.current = new Set(list.map((d) => d.id));
      setLoadError(null);
    } catch {
      // Erro transitório: conserva as pranchetas que já estão na tela e avisa.
      setLoadError("canvas.design.reloadFailed");
    }
  }, []);

  useEffect(() => {
    known.current = null; // o primeiro carregamento de um canvas só semeia: não avisa dos designs que já existiam
    setNotice(null);
    setUnseen(false);
    setLoadError(null);
    setDetails([]);
    void reload();
  }, [scopeKey, reload]);
  useEffect(() => onDesignChanged(() => { void reload(); }), [reload]);

  return {
    details, reload, notice, unseen, loadError,
    dismissNotice: () => { setNotice(null); setLoadError(null); },
    markSeen: () => { setNotice(null); setUnseen(false); },
  };
}
