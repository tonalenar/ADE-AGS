import type { SettingsSectionId } from "@/app/uiStore";

/**
 * Os grupos das Configurações no chat (prancheta 5). As mesmas seções da página, em três grupos com
 * título em vez dos dois separados por linha.
 */
export const CHAT_SETTINGS_GROUPS: { titleKey: string; items: SettingsSectionId[] }[] = [
  { titleKey: "chat.settingsNav.app", items: ["general", "appearance", "chat", "shortcuts"] },
  { titleKey: "chat.settingsNav.agents", items: ["agents", "accounts", "memory", "decisions"] },
  { titleKey: "chat.settingsNav.tools", items: ["terminal", "devices", "worktrees", "advanced"] },
];

/** As seções novas desta versão (o selo "Novo" da prancheta). */
export const NEW_SETTINGS: ReadonlySet<SettingsSectionId> = new Set(["chat", "devices"]);

/** O nome de uma seção (as mesmas chaves da página). */
export function settingsLabelKey(id: SettingsSectionId): string {
  return `settings.${id}`;
}
