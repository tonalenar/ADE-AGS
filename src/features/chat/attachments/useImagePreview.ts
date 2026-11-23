import { useEffect, useState } from "react";

import { readImage } from "./ipc";

/**
 * Quantas prévias ficam na memória. Uma imagem de 20 MB vira cerca de 27 MB de base64 na URL de dados: sem limite, o
 * cache só cresce durante a sessão. Quem já saiu do cache é lido de novo quando for preciso.
 */
export const PREVIEW_CACHE_MAX = 16;

/** Uma leitura por caminho: a miniatura, o visualizador e a bolha dividem o mesmo resultado. */
const cache = new Map<string, Promise<string | null>>();

/** A URL de dados da imagem de um caminho que a pessoa anexou, ou `null` se sumiu ou não se lê. */
export function loadImage(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) {
    // O uso recente vai para o fim do mapa, que guarda a ordem de inserção: o começo é o menos usado.
    cache.delete(path);
    cache.set(path, hit);
    return hit;
  }
  const loading = readImage(path).then((r) => r.dataUrl).catch(() => null);
  cache.set(path, loading);
  // Uma falha não fica guardada: a próxima vez lê de novo. Senão a miniatura ficava «indisponível» para sempre.
  void loading.then((src) => {
    if (src === null && cache.get(path) === loading) cache.delete(path);
  });
  while (cache.size > PREVIEW_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return loading;
}

/**
 * Quando tentar de novo uma imagem que não se leu. A resposta do agente cita o arquivo antes de a ferramenta terminar
 * de gravá-lo (ou de copiá-lo para a pasta), então a primeira leitura falha por "não encontrado" ou "vazio" e o
 * arquivo aparece segundos depois. Poucas tentativas, espaçadas: depois disso a imagem some de verdade.
 */
export const PREVIEW_RETRY_DELAYS_MS = [1500, 4000, 10000] as const;

/** A prévia de uma imagem: a que já se tem (colada) ou a lida do caminho. `missing` = não está mais lá. */
export function useImagePreview(path: string, known: string | null): { src: string | null; missing: boolean } {
  const [loaded, setLoaded] = useState<{ path: string; src: string | null } | null>(null);
  useEffect(() => {
    if (known) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      void loadImage(path).then((src) => {
        if (!alive) return;
        setLoaded({ path, src });
        const delay = PREVIEW_RETRY_DELAYS_MS[n];
        // Falhou: mostra "indisponível" já, mas confere de novo logo mais, caso o arquivo ainda estivesse sendo gravado.
        if (src === null && delay !== undefined) timer = setTimeout(() => attempt(n + 1), delay);
      });
    };
    attempt(0);
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer); };
  }, [path, known]);
  if (known) return { src: known, missing: false };
  if (!loaded || loaded.path !== path) return { src: null, missing: false };
  return { src: loaded.src, missing: loaded.src === null };
}
