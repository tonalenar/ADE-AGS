export const PASTA_REGISTROS: string;
export const ALVOS: Record<string, { arquivos: string[]; semPerda: boolean }>;
export function normalizarRust(fonte: string): string;
export function sha256(texto: string): string;
export function hashDoAlvo(alvo: string, ler?: (caminho: string) => string): string;
export function validarRegistro(reg: unknown, nomeArquivo?: string): string[];
export function nomeDoRegistro(alvo: string, sha: string): string;
export function conferir(
  atuais: Record<string, string>,
  registros: { nome: string; reg: unknown }[],
): { pendentes: { alvo: string; sha: string }[]; invalidos: { nome: string; erros: string[] }[] };
