/**
 * Quando um aparelho que o agente acabou de abrir aparece sobre a conversa (o preview flutuante).
 *
 * Vale a preferência "Auto-show floating preview" (Configurações → Navegador), como no T3 Code. Com ela
 * desligada, o aparelho abre na aba do painel. O agente pode dizer o contrário na própria chamada, igual
 * ao `show` das tools de preview do T3: `show: true` (`--mostrar`) força o flutuante, e `show: false`
 * (`--sem-mostrar`) deixa o aparelho quieto. Sem a flag, vale a preferência.
 */

/** O que o agente pediu: nada (vale a preferência), mostrar à força ou ficar quieto. */
export type DeviceReveal = "default" | "force" | "quiet";

/** Onde o aparelho aparece: flutuando sobre a conversa, na aba do painel, ou em lugar nenhum. */
export type DeviceRevealPlan = "float" | "panel" | "none";

export interface DeviceRevealInput {
  readonly reveal: DeviceReveal;
  readonly autoShowFloatingPreview: boolean;
  /** A conversa que abriu o aparelho é a que está à vista (senão ele só aparece na aba do canvas). */
  readonly conversationOnScreen: boolean;
  /** O painel já mostra a aba desse tipo de aparelho: basta escolher o aparelho nela. */
  readonly panelShowsKind: boolean;
}

/** Decide onde mostrar um aparelho aberto pelo agente. Pura. */
export function planDeviceReveal(input: DeviceRevealInput): DeviceRevealPlan {
  if (input.reveal === "quiet" || !input.conversationOnScreen || input.panelShowsKind) return "none";
  return input.reveal === "force" || input.autoShowFloatingPreview ? "float" : "panel";
}

/** Lê a flag `show` da CLI ou do MCP. Qualquer valor que não seja booleano conta como ausente. Pura. */
export function revealFromShowFlag(show: unknown): DeviceReveal {
  if (show === true) return "force";
  if (show === false) return "quiet";
  return "default";
}
