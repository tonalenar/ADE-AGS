import { invoke } from "@tauri-apps/api/core";

import { getSetting, setSetting } from "@/shared/ipc/settings";

import { AUTOCOMPACT_SETTING, parseAutoCompactConfig, type AutoCompactConfig, type AutoCompactPlan } from "./model";

/** O mapa «agente → medida → mecanismo → suportado» (`conversa::autocompact::plan_table`). */
export const chatAutocompactPlans = () => invoke<AutoCompactPlan[]>("chat_autocompact_plans");

export async function loadAutoCompactConfig(): Promise<AutoCompactConfig> {
  return parseAutoCompactConfig(await getSetting(AUTOCOMPACT_SETTING));
}

export const saveAutoCompactConfig = (config: AutoCompactConfig) => setSetting(AUTOCOMPACT_SETTING, JSON.stringify(config));
