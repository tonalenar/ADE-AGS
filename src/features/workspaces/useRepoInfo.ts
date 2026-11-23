import { useEffect, useRef, useState } from "react";

import { afterFirstFrame } from "@/app/afterFirstFrame";
import { repoInfo } from "@/features/explorer/ipc";
import type { RepoInfo } from "@/features/explorer/types";
import { isDocumentHidden } from "@/shared/visiblePolling";

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;

/** Backoff exponencial quando o git estoura o prazo ou falha sob carga: 3s, 6s, 12s, 24s, 30s. */
export function nextRepoRetryMs(attempt: number): number {
  const step = Math.max(1, attempt);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(step - 1, 4));
}

const invalidators = new Set<(root: string) => void>();

/**
 * Descarta lo que se sabía del repo `root` para que se vuelva a leer.
 *
 * La caché es por carpeta y para siempre, lo cual está bien mientras nada cambie — pero el
 * panel de control de versiones cambia el repo (commitea, cambia de rama), y sin avisar
 * acá las marcas del árbol y la rama del lateral seguirían mostrando lo de antes.
 */
export function invalidateRepoInfo(root: string) {
  invalidators.forEach((invalidate) => invalidate(root));
}

/**
 * Resuelve cada `cwd` contra git, una sola vez por carpeta.
 *
 * Cada resolución son como mucho dos invocaciones a `git`, así que se cachean por ruta:
 * sin eso, cada render del panel dispararía tantos procesos como tabs abiertas. Además
 * no arrancan con la hidratación de las tabs: esperan a que la home haya pintado un
 * cuadro, para que `git` no compita con la primera pantalla. El árbol se dibuja con lo
 * que haya y se reacomoda solo cuando llegan las respuestas.
 *
 * Falha ou timeout do `git` sob carga NÃO entra no cache como "sem repo": tenta de novo
 * com backoff exponencial enquanto a janela estiver visível.
 */
export function useRepoInfo(cwds: string[]): Map<string, RepoInfo> {
  const [cache, setCache] = useState<Map<string, RepoInfo>>(new Map());
  const [version, setVersion] = useState(0);
  const attemptsRef = useRef<Map<string, number>>(new Map());
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timers = retryTimersRef.current;
    const attempts = attemptsRef.current;
    const invalidate = (root: string) => {
      setCache((prev) => {
        const next = new Map(prev);
        for (const [cwd, info] of prev) {
          if (info.root === root || cwd === root || cwd.startsWith(`${root}/`)) next.delete(cwd);
        }
        return next.size === prev.size ? prev : next;
      });
      for (const cwd of [...attempts.keys()]) {
        if (cwd === root || cwd.startsWith(`${root}/`)) {
          attempts.delete(cwd);
          const t = timers.get(cwd);
          if (t !== undefined) clearTimeout(t);
          timers.delete(cwd);
        }
      }
      setVersion((v) => v + 1);
    };
    invalidators.add(invalidate);
    return () => {
      invalidators.delete(invalidate);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Quando a janela volta ao primeiro plano, retenta pastas que estavam em backoff.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (isDocumentHidden()) return;
      if (attemptsRef.current.size === 0) return;
      for (const t of retryTimersRef.current.values()) clearTimeout(t);
      retryTimersRef.current.clear();
      setVersion((v) => v + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // La clave es el CONTENIDO, no el array: `cwds` se rearma en cada render y comparar la
  // referencia relanzaría el efecto para siempre.
  const key = JSON.stringify([...new Set(cwds)].sort());

  useEffect(() => {
    const wanted: string[] = JSON.parse(key);
    const missing = wanted.filter(
      (cwd) => !cache.has(cwd) && !inFlightRef.current.has(cwd) && !retryTimersRef.current.has(cwd),
    );
    if (missing.length === 0) return;

    let stale = false;
    afterFirstFrame().then(() => {
      if (stale) return;
      const toFetch = missing.filter(
        (cwd) => !inFlightRef.current.has(cwd) && !retryTimersRef.current.has(cwd),
      );
      if (toFetch.length === 0) return;
      for (const cwd of toFetch) inFlightRef.current.add(cwd);

      Promise.all(
        toFetch.map((cwd) =>
          repoInfo(cwd)
            .then((info) => ({ cwd, ok: true as const, info }))
            .catch(() => ({ cwd, ok: false as const }))
            .finally(() => { inFlightRef.current.delete(cwd); }),
        ),
      ).then((results) => {
        if (stale) return;
        const resolved: Array<readonly [string, RepoInfo]> = [];
        for (const res of results) {
          if (res.ok) {
            attemptsRef.current.delete(res.cwd);
            resolved.push([res.cwd, res.info] as const);
          } else {
            // Timeout ou erro transitório: nunca grava "sem repo" no cache; agenda retry com backoff.
            const nextAttempt = (attemptsRef.current.get(res.cwd) ?? 0) + 1;
            attemptsRef.current.set(res.cwd, nextAttempt);
            if (!isDocumentHidden() && !retryTimersRef.current.has(res.cwd)) {
              const delay = nextRepoRetryMs(nextAttempt);
              const timer = setTimeout(() => {
                retryTimersRef.current.delete(res.cwd);
                setVersion((v) => v + 1);
              }, delay);
              retryTimersRef.current.set(res.cwd, timer);
            }
          }
        }
        if (resolved.length > 0) {
          setCache((prev) => {
            const next = new Map(prev);
            for (const [cwd, info] of resolved) next.set(cwd, info);
            return next;
          });
        }
      });
    });

    return () => { stale = true; };
    // `cache` queda fuera a propósito: agregarlo relanzaría el efecto con cada respuesta.
    // `version` sí entra: es la señal de que algo se invalidó o um backoff venceu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  return cache;
}

/** "4m", "2h", "3d" — la edad de una tab, corta como para caber al lado del título. */
export function elapsed(since: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
