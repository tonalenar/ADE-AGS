/**
 * O espaço do composer pela largura da COLUNA da conversa, não pela da janela: com o painel direito
 * aberto a coluna fica estreita mesmo numa janela larga, e uma margem de 48 px de cada lado (o `sm:`
 * do Tailwind olha a janela) deixava o cartão pequeno demais para os controles. Pura.
 */

/** A margem lateral do composer (px) para uma coluna de `width` px. Sem medida (ainda), a de 16 px. */
export function composerGutter(width: number | null): number {
  if (width === null || !Number.isFinite(width) || width <= 0) return 16;
  if (width < 420) return 12;
  if (width < 560) return 16;
  if (width < 700) return 24;
  return 48;
}

/** O vão entre a última mensagem e o composer quando a lista rola até o fim. */
export const COMPOSER_CLEARANCE = 24;
/** A altura do degradê no alto do composer, onde o texto que desce "entra" na caixa. */
export const COMPOSER_FADE = 32;

/**
 * O espaço que o fim da lista reserva embaixo: o composer (medido) mais um vão, para a última mensagem
 * poder subir acima do cartão. Sem medida (ainda), só o vão. Pura.
 */
export function listBottomInset(composerHeight: number): number {
  const h = Number.isFinite(composerHeight) && composerHeight > 0 ? composerHeight : 0;
  return h + COMPOSER_CLEARANCE;
}
