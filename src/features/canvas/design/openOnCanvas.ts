import { boardKey, missionBoardKeysOf } from "../store";
import { designApi } from "./designApi";
import { openDesignOn } from "./openStore";

/**
 * `ags design open`: marca o design como aberto nos canvas onde ele aparece (os da missão dele, ou o da
 * pasta quando não é de missão). Devolve as chaves marcadas. Quem chama cuida de mostrar a tela.
 */
export async function openDesignOnCanvases(designId: string): Promise<string[]> {
  const { design } = await designApi.get(designId);
  let keys: string[] = [];
  if (design.missionId) keys = missionBoardKeysOf(design.missionId);
  else if (design.workspace) keys = [boardKey(design.workspace)];
  for (const key of keys) openDesignOn(key, design.id);
  return keys;
}
