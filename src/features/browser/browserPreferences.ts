/** Preferências locais do navegador embutido. */
export const BROWSER_PREFERENCES_KEY = "cc-browser-preferences-v1";

export interface BrowserPreferences {
  autoShowFloatingPreview: boolean;
  maxRecordingFps: 30 | 60;
}

export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  autoShowFloatingPreview: true,
  maxRecordingFps: 30,
};

export function readBrowserPreferences(): BrowserPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_BROWSER_PREFERENCES;
    const candidate = value as Partial<BrowserPreferences>;
    return {
      autoShowFloatingPreview: candidate.autoShowFloatingPreview !== false,
      maxRecordingFps: candidate.maxRecordingFps === 60 ? 60 : 30,
    };
  } catch {
    return DEFAULT_BROWSER_PREFERENCES;
  }
}

export function saveBrowserPreferences(next: BrowserPreferences): void {
  try {
    localStorage.setItem(BROWSER_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    throw new Error("storage");
  }
}
