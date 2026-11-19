/** A tela em que um atalho deve abrir o composer, preservando Canvas/Abas na casca de trabalho. */
export function newConversationShortcutRoute(chatShell: boolean, pathname: string): string | null {
  if (chatShell) return "/";
  return pathname.startsWith("/workspace") ? null : "/workspace";
}
