export type Violacao = { regra: string; linha: number; detalhe: string };
export type Contagem = Record<string, Record<string, number>>;
export type Diferenca = { arquivo: string; regra: string; antes: number; agora: number };

export const LIMITE_MS: number;
export const REGRAS: Record<string, string>;
export function lex(src: string, lang: "ts" | "rs"): { code: string; comments: string[] };
export function lintTs(src: string): Violacao[];
export function lintRust(src: string, opts?: { todoArquivo?: boolean }): Violacao[];
export function modulosDeTeste(src: string, file: string, opts?: { todos?: boolean }): string[];
export function contar(violacoes: { arquivo: string; regra: string }[]): Contagem;
export function comparar(atual: Contagem, baseline: Contagem): { novas: Diferenca[]; encolheu: Diferenca[] };
export function varrer(root: string): (Violacao & { arquivo: string })[];
