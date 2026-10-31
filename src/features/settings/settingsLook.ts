import { createContext, useContext } from "react";

/**
 * O visual das Configurações: o de sempre (`classic`, Ajustes do macOS) ou o do modo chat (`chat`,
 * prancheta 5: cartões com borda, linhas de 14 px, chave azul). A `SettingsPage` escolhe; as seções
 * só usam `SettingsSection`/`SettingsGroup`/`SettingsRow` e herdam o visual.
 */
export type SettingsLook = "classic" | "chat";

export const SettingsLookContext = createContext<SettingsLook>("classic");

export const useSettingsLook = () => useContext(SettingsLookContext);
