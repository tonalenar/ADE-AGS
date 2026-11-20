import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

/**
 * Esperas (ms) antes de cada nova tentativa automática de carregar um vídeo que falhou. O agente costuma citar o
 * arquivo enquanto ele ainda está sendo gravado ou convertido (um MP4 com o índice `moov` no fim dá erro 4 até
 * terminar); recarregar a mesma URL depois que o arquivo fechou toca. Falha definitiva só depois de esgotar a lista.
 */
export const VIDEO_RETRY_DELAYS_MS: readonly number[] = [1500, 5000];

export interface VideoRetry {
  /** Entra na `key` do `<video>`: mudar recria o elemento e dispara uma nova carga. */
  reloadKey: number;
  /** Esgotou as tentativas automáticas: hora de mostrar o aviso. */
  failed: boolean;
  /** Código do `MediaError` da última falha (2 rede, 3 decodificação, 4 formato/arquivo não suportado). */
  code: number | null;
  onError: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onLoaded: () => void;
  /** Pedido da pessoa: zera as tentativas e carrega de novo. */
  retry: () => void;
}

/** Recarrega sozinho um `<video>` que falhou ao carregar (poucas vezes) e guarda o estado da falha definitiva. */
export function useVideoRetry(path: string): VideoRetry {
  const [state, setState] = useState({ reloadKey: 0, auto: 0, failed: false, code: null as number | null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  // Outro arquivo (ou desmontar): começa do zero e não deixa uma tentativa pendente do vídeo anterior.
  useEffect(() => {
    setState({ reloadKey: 0, auto: 0, failed: false, code: null });
    return clear;
  }, [path]);
  const onError = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const code = event.currentTarget.error?.code ?? null;
    clear();
    setState((cur) => {
      if (cur.auto >= VIDEO_RETRY_DELAYS_MS.length) return { ...cur, failed: true, code };
      timer.current = setTimeout(() => {
        timer.current = null;
        setState((now) => ({ ...now, reloadKey: now.reloadKey + 1, auto: now.auto + 1 }));
      }, VIDEO_RETRY_DELAYS_MS[cur.auto]);
      return { ...cur, code };
    });
  }, []);
  const onLoaded = useCallback(() => { clear(); setState((cur) => ({ ...cur, failed: false, code: null })); }, []);
  const retry = useCallback(() => { clear(); setState((cur) => ({ reloadKey: cur.reloadKey + 1, auto: 0, failed: false, code: null })); }, []);
  return { reloadKey: state.reloadKey, failed: state.failed, code: state.code, onError, onLoaded, retry };
}
