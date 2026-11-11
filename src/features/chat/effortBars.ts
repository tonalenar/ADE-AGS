/**
 * O esforço no composer em barras (Configurações → Aparência → Esforço no composer). Quantas barras
 * acendem é a posição do nível na lista do modelo: o primeiro nível acende uma, o último, todas. Pura.
 * `null` quando não há barra a desenhar (o padrão, ou um nível que o modelo não oferece): aí o composer
 * segue mostrando o nome.
 */
export function effortBars(value: string | null, efforts: readonly string[]): { lit: number; total: number } | null {
  if (!value || efforts.length === 0) return null;
  const index = efforts.indexOf(value);
  if (index < 0) return null;
  return { lit: index + 1, total: efforts.length };
}
