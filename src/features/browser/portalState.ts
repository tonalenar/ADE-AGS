/**
 * O estado de um portal para `ags portals` (plano v2, Fase 1.6, achado I6): o agente vê se pode agir já ou o que esperar.
 * Pura: quem chama junta o que o navegador sabe.
 */
import type { LoadState } from "./pageChannel";

export type PortalState = "pronto" | "carregando" | "sem runtime" | "oculto";

export interface PortalStateInfo { state: PortalState; hint: string }

export function portalStateOf(host: { load: LoadState } | undefined, windowHidden: boolean): PortalStateInfo {
  if (windowHidden) {
    return { state: "oculto", hint: "a janela do ADE AGS está oculta ou minimizada: peça ao usuário para trazê-la à frente" };
  }
  if (!host) {
    return { state: "oculto", hint: "o nó do portal não está desenhado (o canvas está em outra vista): ele aparece quando o usuário abre o canvas" };
  }
  const { loadCount, ready, navigatingForMs } = host.load;
  if (navigatingForMs !== null || (loadCount > 0 && !ready)) {
    return { state: "carregando", hint: "a página está carregando: espere com `ags portal wait <portal> --idle`" };
  }
  if (loadCount === 0) {
    return { state: "sem runtime", hint: "nenhuma página com o runtime do ADE AGS carregou: use `ags portal navigate <portal> <url>`" };
  }
  return { state: "pronto", hint: "pode agir" };
}
