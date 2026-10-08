import { useLayoutEffect, useState } from "react";

/**
 * Onde as telas cheias se montam (Missões, Squads, Configurações…): um contêiner que o
 * AppShell deixa cobrindo TUDO o que fica à direita do riel — o painel de workspaces, a área
 * de trabalho e o explorador —, e só isso: a barra de título, o riel e a barra de baixo
 * continuam à vista, que é por onde se sai e se troca de tela (prancheta 2 e 5).
 *
 * Está sempre montado (vazio, sem pegar cliques); cada tela entra nele por portal.
 */
export const PAGE_HOST_ID = "cc-page-host";

/** O contêiner, assim que existe. `null` enquanto o AppShell ainda não o pintou (ou num teste). */
export function usePageHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.getElementById(PAGE_HOST_ID));
  useLayoutEffect(() => {
    setHost(document.getElementById(PAGE_HOST_ID));
  }, []);
  return host;
}
