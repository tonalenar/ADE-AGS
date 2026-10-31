import type { SettingsSectionId } from "@/app/uiStore";

/**
 * Os grupos da barra das Configurações (prancheta 5), a mesma nas abas, no canvas e no chat: todas
 * as seções da página, em três grupos com título.
 */
export const CHAT_SETTINGS_GROUPS: { titleKey: string; items: SettingsSectionId[] }[] = [
  { titleKey: "chat.settingsNav.app", items: ["general", "appearance", "chat", "shortcuts"] },
  { titleKey: "chat.settingsNav.agents", items: ["agents", "accounts", "permissions", "memory", "decisions"] },
  { titleKey: "chat.settingsNav.tools", items: ["terminal", "devices", "worktrees", "advanced"] },
];

/** As seções novas desta versão (o selo "Novo" da prancheta). */
export const NEW_SETTINGS: ReadonlySet<SettingsSectionId> = new Set(["chat", "devices", "permissions"]);

/** O nome de uma seção (as mesmas chaves da página). */
export function settingsLabelKey(id: SettingsSectionId): string {
  return `settings.${id}`;
}

/**
 * O que a busca da barra encontra em cada seção, além do nome dela: as chaves das abas e dos
 * ajustes de dentro (Idioma acha Geral) e algumas palavras soltas. O `Record` obriga a ter todas.
 */
export const SETTINGS_SEARCH: Record<SettingsSectionId, { keys: string[]; words?: string[] }> = {
  general: { keys: ["settings.general.prefs", "settings.sync", "settings.updates", "settings.language"] },
  appearance: { keys: ["settings.theme"] },
  chat: { keys: ["chat.settings.toggle", "chat.settings.worktree", "chat.settings.plan"] },
  shortcuts: { keys: [] },
  agents: { keys: ["settings.tuis", "settings.orchestrator", "settings.routing", "settings.prelaunch", "settings.skillsDir", "settings.skillssh"] },
  accounts: { keys: [] },
  memory: { keys: [] },
  decisions: { keys: ["settings.decisions.provider"], words: ["laya", "jev"] },
  terminal: { keys: [] },
  devices: { keys: [], words: ["ios", "android", "simulador", "simulator"] },
  worktrees: { keys: [], words: ["git", "branch"] },
  permissions: { keys: ["chat.rules.title", "chat.rules.inbox"], words: ["aprovação", "approval", "sempre permitir", "regras", "rules"] },
  advanced: { keys: ["settings.cli", "settings.graphify"] },
};

/** A seção casa com a busca? `q` já vem aparado e em minúsculas; vazio casa com tudo. Pura. */
export function settingsMatch(id: SettingsSectionId, q: string, t: (key: string) => string): boolean {
  if (!q) return true;
  const { keys, words = [] } = SETTINGS_SEARCH[id];
  return [settingsLabelKey(id), ...keys].map((k) => t(k)).concat(words).join(" ").toLocaleLowerCase().includes(q);
}
