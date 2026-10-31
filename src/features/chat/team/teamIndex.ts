import { create } from "zustand";

import type { TeamView } from "./ipc";

/**
 * A lista de times, num store sem dependências: o `teamStore` a copia para cá. A grade das Abas
 * (`canvas/gridMode.ts`, no caminho do layout) lê daqui e não puxa o `teamStore` inteiro, que
 * depende de quase todo o app.
 */
export const useTeamIndex = create<{ teams: TeamView[] }>(() => ({ teams: [] }));
