import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { inspectPaths } from "./ipc";
import { forgetPendingCaptures, pendingCapturePaths, removedCapturePaths, splitRestorableCaptures } from "./pendingCaptures";

interface ComposerCapturesOptions {
  /** A conversa ou o alvo do composer (a mesma ref do `composerTarget`). Sem alvo, nada é guardado. */
  target: string | null | undefined;
  /** Os anexos do rascunho agora. */
  list: readonly { path: string }[];
  /** Devolve caminhos ao rascunho, com a inspeção e os avisos do composer. */
  addPaths: (paths: string[]) => Promise<boolean>;
  /** Mostra uma linha de status no composer. */
  notify: (message: string) => void;
}

/**
 * Mantém as capturas pendentes do composer em dia.
 *
 * - Ao montar (ou trocar de alvo), devolve ao rascunho as capturas que ficaram sem enviar. Arquivo que sumiu
 *   sai do registro com aviso, para não voltar para sempre.
 * - Depois disso, tira do registro só o que saiu do rascunho (enviado, removido ou guardado num stash).
 *   Captura que ainda não entrou na lista (chegou pela fila) nunca é apagada por engano.
 */
export function useComposerCaptures({ target, list, addPaths, notify }: ComposerCapturesOptions): void {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const addRef = useRef(addPaths);
  addRef.current = addPaths;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const previousRef = useRef<string[] | null>(null);

  useEffect(() => {
    previousRef.current = null;
    if (!target) return;
    const saved = pendingCapturePaths(target);
    if (saved.length === 0) return;
    let active = true;
    void (async () => {
      try {
        const inspected = await inspectPaths(saved);
        if (!active) return;
        const { usable, missing } = splitRestorableCaptures(inspected);
        if (missing.length > 0) {
          forgetPendingCaptures(target, missing);
          notifyRef.current(tRef.current("screenRecording.pendingMissing", { count: missing.length }));
        }
        if (usable.length > 0) {
          await addRef.current(usable);
          if (active) notifyRef.current(tRef.current("screenRecording.pendingRestored", { count: usable.length }));
        }
      } catch (error) {
        // Sem a inspeção não sabemos o que existe: nada é apagado, e o aviso diz isso.
        if (active) notifyRef.current(tRef.current("screenRecording.pendingInspectFailed", { error: String(error) }));
      }
    })();
    return () => { active = false; };
  }, [target]);

  useEffect(() => {
    const now = list.map((item) => item.path);
    const previous = previousRef.current;
    previousRef.current = now;
    if (!target || previous === null) return;
    const removed = removedCapturePaths(previous, now);
    if (removed.length > 0) forgetPendingCaptures(target, removed);
  }, [list, target]);
}
