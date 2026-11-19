/**
 * O seletor Chat | Abas | Canvas: a conversa por protocolo aberta vence a aba oculta; sua chave ativa
 * preserva pertencimento a time ou canvas especial. Sem uma chave pronta, usa a sessão dela. Pura.
 */
export function canvasKeyFor(activeBoardKey: string | null, threadCwd: string | null, keyOfFolder: (cwd: string) => string, threadRef?: string | null): string | null {
  if (threadCwd) return activeBoardKey ?? (threadRef ? `${keyOfFolder(threadCwd)}#s:${threadRef}` : keyOfFolder(threadCwd));
  return activeBoardKey;
}
