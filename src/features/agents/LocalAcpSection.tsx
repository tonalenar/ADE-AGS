import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, EditIcon, Input, TrashIcon } from "neogestify-ui-components";

import { AlertaToast } from "@/shared/ui/alerts";
import { SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";

import { useLocalAcpStore } from "./localAcpStore";
import type { LocalAcpConfig, LocalAcpDraft } from "./localAcpIpc";

function LocalAcpForm({ initial, onCancel, onSave }: {
  initial?: LocalAcpConfig;
  onCancel?: () => void;
  onSave: (draft: LocalAcpDraft) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(initial?.args.join("\n") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim() || !command.trim()) {
      setError(t("settings.agents.acp.required"));
      return;
    }
    setBusy(true);
    try {
      await onSave({ id: initial?.id, label: label.trim(), command: command.trim(), args: args.split(/\r?\n/).filter((arg) => arg.length > 0) });
      setError("");
      if (!initial) { setLabel(""); setCommand(""); setArgs(""); }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-4 dark:border-white/15 dark:bg-white/[0.025]">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
          {t("settings.agents.acp.name")}
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("settings.agents.acp.namePlaceholder")} variant="outline" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
          {t("settings.agents.acp.executable")}
          <Input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("settings.agents.acp.executablePlaceholder")} variant="outline" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
        {t("settings.agents.acp.arguments")}
        <textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} placeholder={t("settings.agents.acp.argumentsPlaceholder")}
          className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 outline-none focus:border-accent-500 dark:border-white/15 dark:bg-surface-raised dark:text-white" />
        <span className="font-normal text-gray-400 dark:text-white/40">{t("settings.agents.acp.argumentsHint")}</span>
      </label>
      <p className="m-0 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-800 dark:text-amber-300">
        {t("settings.agents.acp.safety")}
      </p>
      {error && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {onCancel && <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>{t("btn.cancel")}</Button>}
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>{busy ? t("settings.agents.acp.saving") : t(initial ? "btn.save" : "settings.agents.acp.add")}</Button>
      </div>
    </div>
  );
}

export function LocalAcpSection() {
  const { t } = useTranslation();
  const providers = useLocalAcpStore((state) => state.providers);
  const loaded = useLocalAcpStore((state) => state.loaded);
  const load = useLocalAcpStore((state) => state.load);
  const get = useLocalAcpStore((state) => state.get);
  const save = useLocalAcpStore((state) => state.save);
  const remove = useLocalAcpStore((state) => state.remove);
  const [editing, setEditing] = useState<LocalAcpConfig | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => { if (!loaded) void load().catch((error) => AlertaToast(t("settings.agents.acp.title"), String(error), "error", 6000)); }, [loaded, load, t]);

  const edit = async (id: string) => {
    setLoadingId(id);
    try { setEditing(await get(id)); }
    catch (error) { AlertaToast(t("settings.agents.acp.title"), String(error), "error", 6000); }
    finally { setLoadingId(null); }
  };

  const deleteProvider = async (id: string) => {
    if (deleteId !== id) { setDeleteId(id); return; }
    setDeleteId(null);
    try { await remove(id); }
    catch (error) { AlertaToast(t("settings.agents.acp.title"), String(error), "error", 6000); }
  };

  return (
    <SettingsSection title={t("settings.agents.acp.title")} description={t("settings.agents.acp.description")}>
      <SettingsGroup>
        {!providers.length && loaded && <p className="px-4 py-3 text-xs text-gray-500 dark:text-white/45">{t("settings.agents.acp.empty")}</p>}
        {providers.map((provider) => editing?.id === provider.id ? (
          <div key={provider.id} className="p-3"><LocalAcpForm initial={editing} onCancel={() => setEditing(null)} onSave={async (draft) => { await save(draft); setEditing(null); }} /></div>
        ) : (
          <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent-500" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">{provider.label}</span>
            <Button variant="outline" size="sm" disabled={loadingId === provider.id} onClick={() => void edit(provider.id)}>
              <EditIcon className="mr-1.5 h-3.5 w-3.5" />{t("btn.edit")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void deleteProvider(provider.id)}>
              <TrashIcon className="mr-1.5 h-3.5 w-3.5" />{deleteId === provider.id ? t("settings.agents.acp.confirmDelete") : t("btn.delete")}
            </Button>
          </div>
        ))}
      </SettingsGroup>
      {!editing && <LocalAcpForm onSave={save} />}
    </SettingsSection>
  );
}
