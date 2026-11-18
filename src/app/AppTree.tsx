import { useEffect } from "react";
import { ThemeProvider, useTheme } from "neogestify-ui-components";

import { Boot } from "@/app/Boot";
import { observeAppearanceMode } from "@/features/settings/appearanceMode";

function AppearanceModeSync() {
  const { setTheme } = useTheme();
  useEffect(() => observeAppearanceMode(setTheme), [setTheme]);
  return null;
}

/** Árvore que a janela pinta: a fronteira do boot, se houver, não pode envolver a casca. */
export function AppTree({ appReady }: { appReady: Promise<void> }) {
  return (
    <ThemeProvider>
      <AppearanceModeSync />
      <Boot appReady={appReady} />
    </ThemeProvider>
  );
}
