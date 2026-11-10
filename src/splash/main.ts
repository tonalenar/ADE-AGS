import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { fillSplashTexts, showSplashStep, splashTexts } from "./view";
import { readAppearanceMode, resolveAppearanceMode } from "@/features/settings/appearanceMode";

// A janelinha de abertura. Tema e idioma vêm do mesmo `localStorage` que o app usa (mesma origem), e
// a janela só aparece depois de pintada com eles: nasce escondida para não piscar branca.
const mode = readAppearanceMode();
const theme = resolveAppearanceMode(mode, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
localStorage.setItem("theme", theme);
document.documentElement.classList.toggle("dark", theme === "dark");
fillSplashTexts(splashTexts(localStorage.getItem("language"), navigator.language));

void (async () => {
  // Primeiro escuta, depois pergunta onde o boot já está: assim nenhum aviso cai no vão.
  await listen<number>("ags-splash-step", (event) => showSplashStep(event.payload)).catch(() => undefined);
  const step = await invoke<number>("app_boot_step").catch(() => 0);
  showSplashStep(step);
  await invoke("app_window_ready").catch(() => undefined);
})();
