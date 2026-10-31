/**
 * Uma tela cheia por cima da casca (Configurações, Missões, Skills…). O chat não é uma rota: a
 * inicial (`/`) e o workspace (`/workspace`) são o fundo, e com o chat ligado o fundo é a conversa.
 * Pura.
 */
export function isPageRoute(pathname: string): boolean {
  return pathname !== "/" && !pathname.startsWith("/workspace");
}
