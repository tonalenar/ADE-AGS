import type { SettingsSectionId } from "@/app/uiStore";

/**
 * Os dois grupos da barra lateral das Configurações (a linha entre eles é a da prancheta). No modo
 * chat, a barra lateral do chat mostra as mesmas seções em três grupos (`CHAT_SETTINGS_GROUPS`).
 */
export const SETTINGS_NAV: SettingsSectionId[][] = [
  ["general", "appearance", "chat", "accounts", "agents"],
  ["memory", "terminal", "shortcuts", "decisions", "devices", "worktrees", "advanced"],
];
