/**
 * Por que a página não respondeu a uma ordem (plano v2, Fase 1.3, achado I5). Antes um só texto («não respondeu em 12 s»)
 * servia para runtime ausente, página congelada e navegação lenta; o agente repetia a ordem sem saber o que mudar. Cada causa
 * diz o que fazer. Pura: quem chama junta o que sabe (carga, visibilidade, batimento) e o texto sai daqui.
 */

export type PageStall = "hidden" | "no-runtime" | "navigating" | "heavy" | "unknown";

export interface PageStallFacts {
  timeoutMs: number;
  /** A janela do app estava oculta/minimizada durante a espera (WebView2 estrangula temporizadores e renderização). */
  hidden: boolean;
  /** Quantos documentos já avisaram `page:ready` neste navegador; 0 = o runtime nunca falou. */
  loadCount: number;
  /** O documento atual já chegou a DOMContentLoaded. */
  ready: boolean;
  /** Há quanto tempo (ms) uma navegação foi pedida e o documento novo ainda não avisou; `null` se nenhuma está pendente. */
  navigatingForMs: number | null;
  /** Pior atraso do laço de eventos da UI durante a espera (batimento da Fase 0.1). */
  lagMaxMs: number;
}

/** Acima disto a interface ficou presa tempo bastante para explicar a falta de resposta. */
export const HEAVY_LAG_MS = 700;

/** Uma navegação pedida há mais que isto sem o documento novo avisar já não é «carregando»: o runtime não chegou. */
export const NAVIGATION_GRACE_MS = 25_000;

export function classifyStall(f: PageStallFacts): PageStall {
  if (f.hidden) return "hidden";
  if (f.navigatingForMs !== null && f.navigatingForMs >= NAVIGATION_GRACE_MS) return "no-runtime";
  if (f.navigatingForMs !== null || (f.loadCount > 0 && !f.ready)) return "navigating";
  if (f.loadCount === 0) return "no-runtime";
  if (f.lagMaxMs >= HEAVY_LAG_MS) return "heavy";
  return "unknown";
}

export function stallMessage(f: PageStallFacts): string {
  const secs = Math.round(f.timeoutMs / 1000);
  switch (classifyStall(f)) {
    case "hidden":
      return `A janela do ADE AGS está oculta ou minimizada: o navegador do canvas fica quase parado assim (a página não respondeu em ${secs} s). Peça ao usuário para trazer a janela à frente e repita a ordem; não adianta repetir antes.`;
    case "navigating":
      return `A página ainda está navegando ou carregando (sem resposta em ${secs} s). Espere com \`ags portal wait <portal> --idle\` (ou \`snapshot\` depois de alguns segundos) e repita; não reenvie a ação: ela pode já ter funcionado.`;
    case "no-runtime":
      return `O runtime do ADE AGS não está nesta página (nenhum documento avisou que carregou em ${secs} s). Causas comuns: o endereço não passa pelo proxy, a página não é HTML, ou o navegador ainda não abriu. Use \`ags portal navigate <portal> <url>\` de novo; se persistir, tente outro endereço.`;
    case "heavy":
      return `A página está pesada e prendeu o renderizador (atraso de até ${Math.round(f.lagMaxMs)} ms na interface; sem resposta em ${secs} s). Espere alguns segundos com \`ags portal wait <portal> --idle\` e leia com \`snapshot\`; evite várias ordens seguidas até ela assentar.`;
    default:
      return `A página não respondeu em ${secs} s e não achei a causa (janela visível, runtime presente, sem navegação). Tente \`ags portal snapshot <portal>\`; se repetir, recarregue com \`ags portal history <portal> reload\`.`;
  }
}
