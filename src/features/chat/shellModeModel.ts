/**
 * O seletor Chat | Abas | Canvas: a chave do canvas que ele abre. O canvas é por pasta; a aba ativa dá
 * a chave, mas com uma conversa por protocolo na tela (sem aba) não havia chave e o Canvas sumia do
 * seletor. Nesse caso vale a pasta da conversa. Pura.
 */
export function canvasKeyFor(activeBoardKey: string | null, threadCwd: string | null, keyOfFolder: (cwd: string) => string): string | null {
  // A conversa por protocolo na tela é a que vale (a aba "ativa" pode ser outra, escondida).
  if (threadCwd) return keyOfFolder(threadCwd);
  return activeBoardKey;
}
