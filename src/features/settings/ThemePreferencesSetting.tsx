import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";

import { readAppearanceMode, resolveAppearanceMode } from "./appearanceMode";
import {
  addTheme,
  colorsForTheme,
  createTheme,
  exportThemeFile,
  parseThemeImport,
  readThemePreferences,
  removeTheme,
  selectTheme,
  starterColors,
  THEME_PREFERENCES_KEY,
  updateTheme,
  type CustomTheme,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemePreferences,
} from "./themePreferences";
import { SettingsGroup, SettingsSection } from "./SettingsSection";

const EDITABLE_ROLES: ThemeColorRole[] = [
  "canvas", "chrome", "surface", "surfaceRaised", "surfaceOverlay", "text", "textMuted", "border", "input",
  "focus", "accent", "accentForeground", "sidebar", "sidebarForeground", "messageSurface", "messageForeground",
  "accentSurface", "accentSurfaceForeground", "codeBackground", "codeForeground", "terminalBackground", "terminalForeground",
  "terminalCursor", "terminalSelection",
];

export function ThemePreferencesSetting() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preferences, setPreferences] = useState<ThemePreferences>(readThemePreferences);
  const [appearance, setAppearance] = useState<ThemeAppearance>(() => resolvedAppearance());
  const [editAppearance, setEditAppearance] = useState<ThemeAppearance>(() => resolvedAppearance());
  const [nameDraft, setNameDraft] = useState("");
  const [message, setMessage] = useState("");
  const active = preferences.themes.find((theme) => theme.id === preferences.activeThemeId) ?? null;

  useEffect(() => setNameDraft(active?.name ?? ""), [active?.id, active?.name]);

  useEffect(() => {
    const refresh = () => {
      setPreferences(readThemePreferences());
      const next = resolvedAppearance();
      setAppearance(next);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_PREFERENCES_KEY || event.key === "ade-appearance-mode" || event.key === "theme") refresh();
    };
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", refresh);
    window.addEventListener("storage", storage);
    window.addEventListener("ade-appearance-mode-changed", refresh);
    return () => {
      media?.removeEventListener?.("change", refresh);
      window.removeEventListener("storage", storage);
      window.removeEventListener("ade-appearance-mode-changed", refresh);
    };
  }, []);

  const currentColors = useMemo(() => {
    if (!active) return null;
    return colorsForTheme(active, editAppearance) ?? starterColors(editAppearance);
  }, [active, editAppearance]);

  const sync = (next: ThemePreferences) => {
    setPreferences(next);
    setMessage("");
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error("invalid-theme");
      const imported = parseThemeImport(JSON.parse(await file.text()));
      sync(addTheme(imported));
      setEditAppearance(imported.appearance);
      setMessage(t("settings.themeCustom.imported"));
    } catch {
      setMessage(t("settings.themeCustom.invalid"));
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const exportActive = () => {
    if (!active) return;
    const data = exportThemeFile(active);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${active.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ade-theme"}.t3theme.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const updateActive = (patch: Partial<CustomTheme>) => {
    if (!active) return;
    sync(updateTheme(active.id, (theme) => ({ ...theme, ...patch })));
  };

  const updateColor = (role: ThemeColorRole, color: string) => {
    if (!active) return;
    sync(updateTheme(active.id, (theme) => {
      if (theme.appearance === editAppearance) return { ...theme, colors: { ...theme.colors, [role]: color } };
      return { ...theme, variants: { ...theme.variants, [editAppearance]: { ...starterColors(editAppearance), ...theme.variants?.[editAppearance], [role]: color } } };
    }));
  };

  const changeSelection = (id: string) => sync(selectTheme(id || null));

  return (
    <SettingsSection title={t("settings.themeCustom.title")} description={t("settings.themeCustom.description")}>
      <SettingsGroup>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <label className="sr-only" htmlFor="ade-custom-theme-select">{t("settings.themeCustom.select")}</label>
          <PopupSelect id="ade-custom-theme-select" value={preferences.activeThemeId ?? ""} onChange={(event) => changeSelection(event.target.value)} className="min-w-44">
            <option value="">{t("settings.themeCustom.default")}</option>
            {preferences.themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
          </PopupSelect>
          <button type="button" onClick={() => sync(createTheme())} disabled={preferences.themes.length >= 40}
            className="h-8 rounded-md border border-gray-200 px-2.5 text-chat-caption font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-45 dark:border-white/10 dark:text-white/75 dark:hover:bg-white/[0.06]">
            {t("settings.themeCustom.create")}
          </button>
          <button type="button" onClick={() => inputRef.current?.click()}
            className="h-8 rounded-md border border-gray-200 px-2.5 text-chat-caption font-medium text-gray-700 hover:bg-gray-100 dark:border-white/10 dark:text-white/75 dark:hover:bg-white/[0.06]">
            {t("settings.themeCustom.import")}
          </button>
          <input ref={inputRef} type="file" accept=".json,.t3theme.json,application/json" className="hidden" onChange={(event) => void onImport(event.target.files?.[0])} />
          {active && <>
            <button type="button" onClick={exportActive}
              className="h-8 rounded-md border border-gray-200 px-2.5 text-chat-caption font-medium text-gray-700 hover:bg-gray-100 dark:border-white/10 dark:text-white/75 dark:hover:bg-white/[0.06]">
              {t("settings.themeCustom.export")}
            </button>
            <button type="button" onClick={() => sync(removeTheme(active.id))}
              className="h-8 rounded-md px-2.5 text-chat-caption font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-400/10">
              {t("settings.themeCustom.remove")}
            </button>
          </>}
        </div>
        {active && (
          <div className="border-t border-gray-200 px-4 py-4 dark:border-white/[0.08]">
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="ade-theme-name">{t("settings.themeCustom.name")}</label>
              <input id="ade-theme-name" value={nameDraft} maxLength={48}
                onChange={(event) => setNameDraft(event.target.value.slice(0, 48))}
                onBlur={() => {
                  const name = nameDraft.trim();
                  if (name) updateActive({ name });
                  else setNameDraft(active.name);
                }}
                className="h-8 min-w-40 flex-1 rounded-md border border-gray-200 bg-transparent px-2.5 text-chat-ui outline-none focus:border-accent-500 dark:border-white/10 dark:text-white" />
              <label className="sr-only" htmlFor="ade-theme-variant">{t("settings.themeCustom.variant")}</label>
              <PopupSelect id="ade-theme-variant" value={editAppearance} onChange={(event) => setEditAppearance(event.target.value as ThemeAppearance)} className="min-w-32">
                <option value="light">{t("settings.theme.light")}</option>
                <option value="dark">{t("settings.theme.dark")}</option>
              </PopupSelect>
              <span className="text-chat-caption text-gray-500 dark:text-white/45">{t("settings.themeCustom.activeVariant", { mode: t(`settings.theme.${appearance}`) })}</span>
            </div>
            {colorsForTheme(active, appearance) === null && (
              <p className="mt-2 mb-0 text-chat-caption text-amber-700 dark:text-amber-300">{t("settings.themeCustom.variantMissing", { mode: t(`settings.theme.${appearance}`) })}</p>
            )}
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {EDITABLE_ROLES.map((role) => {
                const value = currentColors?.[role] ?? starterColors(editAppearance)[role] ?? "#808080";
                const colorValue = colorInputValue(value);
                return (
                  <label key={role} className="flex min-h-10 items-center gap-3 rounded-lg border border-gray-200 px-3 dark:border-white/[0.08]">
                    <input type="color" value={colorValue} onChange={(event) => updateColor(role, event.target.value)} aria-label={t(`settings.themeCustom.role.${role}`)}
                      className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <span className="min-w-0 flex-1 truncate text-chat-caption text-gray-700 dark:text-white/75">{t(`settings.themeCustom.role.${role}`)}</span>
                    <code className="font-mono text-[10px] text-gray-400 dark:text-white/35">{colorValue}</code>
                  </label>
                );
              })}
            </div>
            <p className="mt-3 mb-0 text-chat-caption text-gray-500 dark:text-white/45">{t("settings.themeCustom.mappingNote")}</p>
          </div>
        )}
        {message && <p role="status" className="px-4 pb-3 text-chat-caption text-gray-600 dark:text-white/65">{message}</p>}
      </SettingsGroup>
    </SettingsSection>
  );
}

function resolvedAppearance(): ThemeAppearance {
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  return resolveAppearanceMode(readAppearanceMode(), systemDark);
}

let colorCanvas: HTMLCanvasElement | null = null;
function colorInputValue(value: string): string {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  try {
    colorCanvas ??= document.createElement("canvas");
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    const context = colorCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "#808080";
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return "#808080";
  }
}
