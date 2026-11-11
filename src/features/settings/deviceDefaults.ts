import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { TERMINAL_ZOOM } from "@/features/terminal/theme";
import { DEFAULT_CHAT_PREFS, loadChatPrefs, saveChatPrefs, type ChatPrefs } from "@/features/chat/chatPrefs";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { readAppearanceMode, setAppearanceMode } from "@/features/settings/appearanceMode";
import { DEFAULT_FONT_PREFERENCES, readFontPreferences, saveFontPreferences } from "@/features/settings/fontPreferences";
import { MOTION_DURATION, readMotionDuration, saveMotionDuration } from "@/features/settings/motionPreferences";
import { NOTIFICATIONS_KEY } from "@/features/settings/notificationsPreference";
import { readInAppNotices, saveInAppNotices } from "@/features/settings/inAppNoticesPreference";
import { DEFAULT_CONFIRM_PREFS, loadConfirmPrefs, saveConfirmPrefs } from "@/features/settings/confirmPreferences";
import { readWorkingShelf, saveWorkingShelf } from "@/features/settings/sidebarPreferences";
import {
  applyThemePreferencesForCurrentAppearance,
  readThemePreferences,
  selectTheme,
} from "@/features/settings/themePreferences";
import { sameSettingValue, type DeviceDefault } from "@/features/settings/deviceDefaultsModel";

/**
 * Os ajustes que "Restaurar padrões do aparelho" devolve ao padrão: as preferências de aparência, de
 * conversa e do terminal que a ADE guarda neste aparelho, cada uma com o padrão que o código já usa.
 *
 * Ficam de fora de propósito: sandbox, permissões e regras, contas e chaves, memória, decisões do Jev,
 * atalhos (que têm o próprio "Restaurar"), a atualização automática de agentes, sincronização, pastas e
 * dispositivos. Restaurar o que é de segurança ou de dados sem pedido seria perder coisa sem querer.
 */
/**
 * Os campos de comportamento das conversas (o fluxo de mensagens, a largura, as skills no menu "/", o
 * worktree novo e os submódulos). As escolhas do composer (pasta, agente, modelo, esforço, conta,
 * permissão, modo plano, fast) ficam de fora: são a última escolha, não um padrão.
 */
function chatBehaviorOf(prefs: ChatPrefs) {
  return {
    followUpBehavior: prefs.followUpBehavior,
    width: prefs.width,
    showSkillsInSlashMenu: prefs.showSkillsInSlashMenu,
    worktree: prefs.worktree,
    worktreeSubmodules: prefs.worktreeSubmodules,
  };
}

export const DEVICE_DEFAULTS: readonly DeviceDefault[] = [
  {
    id: "appearance",
    labelKey: "settings.restoreDefaults.item.appearance",
    changed: () => readAppearanceMode() !== "dark",
    restore: ({ setTheme }) => setAppearanceMode("dark", setTheme),
  },
  {
    id: "motion",
    labelKey: "settings.restoreDefaults.item.motion",
    changed: () => readMotionDuration() !== MOTION_DURATION.default,
    restore: () => {
      saveMotionDuration(MOTION_DURATION.default);
    },
  },
  {
    id: "fonts",
    labelKey: "settings.typography",
    changed: () => !sameSettingValue(readFontPreferences(), DEFAULT_FONT_PREFERENCES),
    // `saveFontPreferences` também aplica o valor na janela.
    restore: () => saveFontPreferences(DEFAULT_FONT_PREFERENCES),
  },
  {
    id: "customTheme",
    labelKey: "settings.restoreDefaults.item.customTheme",
    // Os temas que a pessoa criou ficam; só se desmarca o que está ativo.
    changed: () => readThemePreferences().activeThemeId !== null,
    restore: () => {
      selectTheme(null);
      applyThemePreferencesForCurrentAppearance();
    },
  },
  {
    id: "notifications",
    labelKey: "settings.notifications.label",
    changed: async () => (await getSetting(NOTIFICATIONS_KEY)) === "false",
    restore: () => setSetting(NOTIFICATIONS_KEY, "true"),
  },
  {
    id: "inAppNotices",
    labelKey: "settings.inAppNotifications.label",
    // Desligado é o padrão: fora do padrão é quando está ligado.
    changed: () => readInAppNotices(),
    restore: () => saveInAppNotices(false),
  },
  {
    id: "workingShelf",
    labelKey: "settings.sidebar.working.label",
    // Ligada é o padrão: fora do padrão é quando está desligada.
    changed: () => !readWorkingShelf(),
    restore: () => saveWorkingShelf(true),
  },
  {
    id: "confirmations",
    labelKey: "settings.confirm.title",
    changed: () => !sameSettingValue(loadConfirmPrefs(), DEFAULT_CONFIRM_PREFS),
    restore: () => saveConfirmPrefs(DEFAULT_CONFIRM_PREFS),
  },
  {
    id: "chat",
    labelKey: "settings.restoreDefaults.item.chat",
    // Só o comportamento volta ao padrão. A última escolha do composer (pasta, agente, modelo, esforço,
    // conta, permissão) fica como está, como o T3 Code mantém o modelo padrão e as permissões.
    changed: () => !sameSettingValue(chatBehaviorOf(loadChatPrefs()), chatBehaviorOf(DEFAULT_CHAT_PREFS)),
    restore: () => {
      saveChatPrefs({ ...loadChatPrefs(), ...chatBehaviorOf(DEFAULT_CHAT_PREFS) });
    },
  },
  {
    id: "terminal",
    labelKey: "settings.restoreDefaults.item.terminal",
    changed: () => {
      const prefs = useTerminalPrefsStore.getState();
      return prefs.zoom !== TERMINAL_ZOOM.default || !prefs.inputMarks;
    },
    restore: () => {
      const prefs = useTerminalPrefsStore.getState();
      prefs.setZoom(TERMINAL_ZOOM.default);
      prefs.setInputMarks(true);
    },
  },
];
