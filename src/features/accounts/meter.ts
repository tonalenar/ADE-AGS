/** A cor da barra de cota (prancheta 6): a de destaque, âmbar a partir de 60% e vermelha a partir de 80%. Pura. */
export function meterTone(percent: number): string {
  return percent >= 80 ? "bg-red-500" : percent >= 60 ? "bg-amber-500" : "bg-accent-600";
}
