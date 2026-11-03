export type Amostra = { caso: string; pequeno_ms: number; grande_ms: number };
export type Esperado = { pequeno: number; grande: number };
export const RAZAO_MAX: number;
export const ESCALA: number;
export const FOLGA: number;
export const ESPERADO_MS: Record<string, Esperado>;
export const TESTES: Record<string, string[]>;
export function orcamento(esperadoMs: number): number;
export function mediana(valores: number[]): number;
export function lerAmostras(saida: string): Amostra[];
export function julgar(
  caso: string,
  amostras: Amostra[],
  esperado?: Esperado,
): { caso: string; n: number; pequeno: number; grande: number; razao: number; orcamento: Esperado | null; falhas: string[] };
