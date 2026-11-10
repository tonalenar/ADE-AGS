/** O tema visual pedido pela pessoa, independente do tema efetivo usado pelo provider. */
export type AppearanceMode = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<AppearanceMode, "system">;

export const APPEARANCE_MODE_KEY = "ade-appearance-mode";

/** Percorre as três preferências de aparência sem alterar o tema personalizado ativo. */
export function nextAppearanceMode(mode: AppearanceMode): AppearanceMode {
  return mode === "system" ? "light" : mode === "light" ? "dark" : "system";
}

/** Migra a preferência antiga, que só guardava claro/escuro. O padrão continua escuro. */
export function readAppearanceMode(): AppearanceMode {
  try {
    const saved = localStorage.getItem(APPEARANCE_MODE_KEY);
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
    const legacy = localStorage.getItem("theme");
    return legacy === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveAppearanceMode(mode: AppearanceMode, systemIsDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemIsDark ? "dark" : "light") : mode;
}

/** Persiste o modo e aplica a variante efetiva sem esperar a tela de Configurações remontar. */
export function setAppearanceMode(mode: AppearanceMode, setTheme: (theme: ResolvedTheme) => void): void {
  try {
    localStorage.setItem(APPEARANCE_MODE_KEY, mode);
  } catch {
    // A alteração visual ainda funciona nesta sessão se o armazenamento estiver indisponível.
  }
  const systemIsDark = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(resolveAppearanceMode(mode, systemIsDark));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("ade-appearance-mode-changed"));
}

/** Mantém o provider sincronizado com a preferência do sistema e com outra janela da ADE. */
export function observeAppearanceMode(setTheme: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const apply = () => {
    const mode = readAppearanceMode();
    setTheme(resolveAppearanceMode(mode, media?.matches ?? false));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_MODE_KEY || event.key === "theme") apply();
  };
  media?.addEventListener?.("change", apply);
  window.addEventListener("storage", onStorage);
  apply();
  return () => {
    media?.removeEventListener?.("change", apply);
    window.removeEventListener("storage", onStorage);
  };
}
