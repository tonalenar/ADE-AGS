import { useEffect, useState } from "react";

import { marketplaceSkillReadme } from "./ipc";
import { README_DEBOUNCE_MS, skillReadmeCache } from "./skillReadme";

export interface ReadmeState {
  /** El markdown crudo. `null` mientras carga o si este repo no puede servirlo. */
  content: string | null;
  loading: boolean;
  /** Por qué no hay markdown. No es un error a gritar: hay repos que no lo exponen. */
  unavailable: boolean;
}

/**
 * El `SKILL.md` de la entrada elegida.
 *
 * Cada selección dispara una lectura (una descarga, en un repo de GitHub), así que las
 * respuestas que llegan tarde se descartan: sin eso, elegir tres skills rápido deja
 * mostrando el texto de la primera que termine de bajar, no el de la que está marcada.
 */
export function useSkillReadme(registryId: string | null, skillId: string | null): ReadmeState {
  const [state, setState] = useState<ReadmeState>({ content: null, loading: false, unavailable: false });

  useEffect(() => {
    if (!registryId || !skillId) {
      setState({ content: null, loading: false, unavailable: false });
      return;
    }

    const cached = skillReadmeCache.get(registryId, skillId);
    if (cached !== undefined) {
      setState({ content: cached, loading: false, unavailable: false });
      return;
    }

    let stale = false;
    setState({ content: null, loading: true, unavailable: false });
    const handle = window.setTimeout(() => {
      marketplaceSkillReadme(registryId, skillId)
        .then((content) => {
          skillReadmeCache.set(registryId, skillId, content);
          if (!stale) setState({ content, loading: false, unavailable: false });
        })
        .catch(() => {
          if (!stale) setState({ content: null, loading: false, unavailable: true });
        });
    }, README_DEBOUNCE_MS);

    return () => {
      stale = true;
      window.clearTimeout(handle);
    };
  }, [registryId, skillId]);

  return state;
}
