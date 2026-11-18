import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, AddIcon, TrashIcon, EditIcon, InfoIcon } from "neogestify-ui-components";
import { usePrelaunchStore } from "@/features/prelaunch/store";
import type { PrelaunchPreset } from "@/features/prelaunch/types";
import { SettingsSection } from "@/features/settings/SettingsSection";
import { appConfirm } from "@/shared/ui/appConfirm";

/** Alta y edición usan el mismo formulario; `initial` decide cuál de las dos es. */
function PresetForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: PrelaunchPreset;
  onSave: (draft: { id?: string; name: string; command: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ id: initial?.id, name: name.trim(), command: command.trim() });
      if (!initial) {
        setName("");
        setCommand("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const valid = name.trim() && command.trim();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("prelaunch.namePlaceholder")}
          className="sm:w-56"
        />
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && !saving) submit();
          }}
          placeholder={t("prelaunch.commandPlaceholder")}
          className="flex-1 font-mono text-xs"
        />
        <div className="flex gap-2">
          <Button variant="primary" size="sm" onClick={submit} disabled={!valid || saving}
            aria-label={initial ? undefined : t("btn.add")} title={initial ? undefined : t("btn.add")}>
            {initial ? t("btn.save") : <AddIcon className="w-3.5 h-3.5" />}
          </Button>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("btn.cancel")}
            </Button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

/**
 * Comandos que se ejecutan antes de lanzar un agente.
 *
 * Acá solo se guardan; elegir cuáles usar (y en qué orden) pasa al abrir cada tab, en
 * "Opciones avanzadas". La separación es a propósito: un `conda activate ml` se escribe una
 * vez y se reusa, mientras que la cadena concreta cambia según el proyecto.
 */
export function PrelaunchSection() {
  const { t } = useTranslation();
  const presets = usePrelaunchStore((s) => s.presets);
  const loaded = usePrelaunchStore((s) => s.loaded);
  const load = usePrelaunchStore((s) => s.load);
  const save = usePrelaunchStore((s) => s.save);
  const remove = usePrelaunchStore((s) => s.remove);
  const loadError = usePrelaunchStore((s) => s.loadError);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => { if (!loaded) load().catch(() => undefined); }, [loaded, load]);

  /** Apagar um preset quebra os passos que o usam: pede confirmação e mostra o erro na tela, não só no console. */
  const removePreset = async (preset: PrelaunchPreset) => {
    const ok = await appConfirm({
      title: t("prelaunch.removeTitle"),
      lead: t("prelaunch.removeLead", { name: preset.name }),
      confirmLabel: t("btn.delete"),
      cancelLabel: t("btn.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    setRemoveError(null);
    try {
      await remove(preset.id);
    } catch (cause) {
      setRemoveError(t("prelaunch.removeFailed", { detail: String(cause) }));
    }
  };

  return (
    <SettingsSection title={t("settings.prelaunch")} description={t("settings.prelaunch.desc")}>
      {loadError && (
        <p role="alert" className="mb-3 rounded-md border border-red-400/60 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {t("prelaunch.loadFailed", { detail: loadError })}
        </p>
      )}
      {removeError && (
        <p role="alert" className="mb-3 rounded-md border border-red-400/60 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {removeError}
        </p>
      )}

      {presets.length > 0 && (
        <div className="flex flex-col gap-2 mb-4">
          {presets.map((preset) =>
            editingId === preset.id ? (
              <div
                key={preset.id}
                className="px-4 py-3 rounded-xl border border-accent-300 dark:border-accent-500/40
                  bg-accent-50/40 dark:bg-accent-500/5"
              >
                <PresetForm
                  initial={preset}
                  onSave={async (draft) => {
                    await save(draft);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : (
              <div
                key={preset.id}
                className="cc-t group flex items-center justify-between gap-3 px-3 py-2 rounded-lg
                  bg-gray-100/70 dark:bg-white/4
                  hover:bg-gray-100 dark:hover:bg-white/6"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[12.5px] font-semibold text-gray-800 dark:text-gray-100 truncate" title={preset.name}>
                    {preset.name}
                  </span>
                  <code className="text-[10.5px] font-mono text-gray-400 dark:text-white/35 truncate" title={preset.command}>
                    {preset.command}
                  </code>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100
                  focus-within:opacity-100 transition-opacity shrink-0">
                  <Button variant="icon"
                    type="button"
                    onClick={() => setEditingId(preset.id)}
                    aria-label={t("btn.edit")}
                    className="w-7 h-7 grid place-items-center rounded-lg text-gray-400
                      hover:text-gray-700 dark:hover:text-gray-200
                      hover:bg-gray-200/60 dark:hover:bg-white/10 p-0"
                  >
                    <EditIcon className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="icon"
                    type="button"
                    onClick={() => void removePreset(preset)}
                    aria-label={t("btn.delete")}
                    className="w-7 h-7 grid place-items-center rounded-lg text-gray-400
                      hover:text-red-500 hover:bg-red-500/10 p-0"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <PresetForm onSave={async (draft) => { await save(draft); }} />

      <div className="flex items-start gap-2 mt-4 text-xs text-gray-500 dark:text-gray-400">
        <InfoIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>{t("settings.prelaunch.hint")}</p>
      </div>
    </SettingsSection>
  );
}
