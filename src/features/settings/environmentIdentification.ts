import type { EnvironmentIdentification } from "@/features/settings/displayPreferences";

/**
 * O selo de identificação do ambiente no rodapé (Configurações → Aparência). Numa instalação de
 * desenvolvimento (a instância isolada ou `tauri dev`) ele diz "Desenvolvimento", para não confundir
 * com o app instalado. Numa instalação normal, a opção "Sempre" mostra "Instalado". Pura: o modo e o
 * fato de ser build de desenvolvimento entram como argumento.
 */
export type EnvironmentPill = "development" | "installed";

export function environmentPill(mode: EnvironmentIdentification, development: boolean): EnvironmentPill | null {
  if (mode === "none") return null;
  if (development) return "development";
  return mode === "pill" ? "installed" : null;
}
