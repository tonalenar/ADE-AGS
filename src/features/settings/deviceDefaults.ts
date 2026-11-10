import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { TERMINAL_ZOOM } from "@/features/terminal/theme";
import { DEFAULT_CHAT_PREFS, loadChatPrefs, saveChatPrefs } from "@/features/chat/chatPrefs";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { readAppearanceMode, setAppearanceMode } from "@/features/settings/appearanceMode";
import { DEFAULT_FONT_PREFERENCES, readFontPreferences, saveFontPreferences } from "@/features/settings/fontPreferences";
import { MOTION_DURATION, readMotionDuration, saveMotionDuration } from "@/features/settings/motionPreferences";
import { NOTIFICATIONS_KEY } from "@/features/settings/notificationsPreference";
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
    id: "chat",
    labelKey: "settings.restoreDefaults.item.chat",
    // A pasta da conversa nova é do momento, não um padrão: fica como está.
    changed: () => !sameSettingValue({ ...loadChatPrefs(), cwd: null }, DEFAULT_CHAT_PREFS),
    restore: () => {
      saveChatPrefs({ ...DEFAULT_CHAT_PREFS, cwd: loadChatPrefs().cwd });
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
