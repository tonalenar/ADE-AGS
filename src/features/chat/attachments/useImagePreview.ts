import { useEffect, useState } from "react";

import { readImage } from "./ipc";

/** Uma leitura por caminho: a miniatura, o visualizador e a bolha dividem o mesmo resultado. */
const cache = new Map<string, Promise<string | null>>();

/** A URL de dados da imagem de um caminho que a pessoa anexou, ou `null` se sumiu ou não se lê. */
export function loadImage(path: string): Promise<string | null> {
  let hit = cache.get(path);
  if (!hit) {
    hit = readImage(path).then((r) => r.dataUrl).catch(() => null);
    cache.set(path, hit);
  }
  return hit;
}

/** Esquece o que se guardou de um caminho (o arquivo mudou ou foi limpo). */
export function forgetImage(path: string): void {
  cache.delete(path);
}

/** A prévia de uma imagem: a que já se tem (colada) ou a lida do caminho. `missing` = não está mais lá. */
export function useImagePreview(path: string, known: string | null): { src: string | null; missing: boolean } {
  const [loaded, setLoaded] = useState<{ path: string; src: string | null } | null>(null);
  useEffect(() => {
    if (known) return;
    let alive = true;
    void loadImage(path).then((src) => { if (alive) setLoaded({ path, src }); });
    return () => { alive = false; };
  }, [path, known]);
  if (known) return { src: known, missing: false };
  if (!loaded || loaded.path !== path) return { src: null, missing: false };
  return { src: loaded.src, missing: loaded.src === null };
}
