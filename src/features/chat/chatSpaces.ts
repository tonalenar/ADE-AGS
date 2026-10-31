/**
 * Os "Espaços" do modo chat (prancheta 6): as telas cheias de hoje (Missões, Frota, Squads…) abertas
 * dentro da casca, com a sidebar listando todas. Cada espaço é a MESMA rota de sempre; Memória é a
 * seção das Configurações (não tem rota própria). Puro.
 */
export interface ChatSpace {
  id: string;
  /** A rota que abre o espaço. */
  path: string;
  /** A chave i18n do nome (as do riel, para o nome ser o mesmo nos dois modos). */
  labelKey: string;
  /** O glifo da prancheta (texto, herda a cor). */
  glyph: string;
  /** Abre uma seção das Configurações em vez de uma rota própria. */
  settingsSection?: "memory";
}

export const CHAT_SPACES: ChatSpace[] = [
  { id: "missions", path: "/missions", labelKey: "sidebar.missions", glyph: "◇" },
  { id: "fleet", path: "/fleet", labelKey: "sidebar.fleet", glyph: "≡" },
  { id: "squads", path: "/squads", labelKey: "sidebar.squads", glyph: "◎" },
  { id: "skills", path: "/skills", labelKey: "sidebar.skills", glyph: "✦" },
  { id: "marketplace", path: "/marketplace", labelKey: "sidebar.marketplace", glyph: "⊞" },
  { id: "forge", path: "/forge", labelKey: "sidebar.forge", glyph: "⑂" },
  { id: "sessions", path: "/sessions", labelKey: "chat.spaces.history", glyph: "◷" },
  { id: "memory", path: "/settings", labelKey: "settings.memory", glyph: "◈", settingsSection: "memory" },
];

/** As Configurações têm a sidebar própria (as seções); as outras telas, a dos Espaços. */
export function isSettingsRoute(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** O espaço da rota aberta (o detalhe de uma skill é Skills; os registries, Marketplace). */
export function spaceForPath(pathname: string): ChatSpace | null {
  if (isSettingsRoute(pathname)) return null;
  return CHAT_SPACES.find((s) => pathname === s.path || pathname.startsWith(`${s.path}/`)) ?? null;
}
