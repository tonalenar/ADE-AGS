import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { CustomAgentForm } from "@/features/agents/CustomAgentForm";
import type { LocalAcpConfig, LocalAcpDraft } from "@/features/agents/localAcpIpc";
import { useLocalAcpStore } from "@/features/agents/localAcpStore";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { SettingsGroup } from "@/features/settings/SettingsSection";
import { AlertaToast } from "@/shared/ui/alerts";
import { AppDialog } from "@/shared/ui/AppDialog";
import { uiErrorText } from "@/shared/uiErrorText";

type CustomKind = "tui" | "acp";

function RowMenu({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-[16px] leading-none transition-colors
          ${open
            ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white"
            : "text-gray-400 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white"}`}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+4px)] z-30 w-44 rounded-xl border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-surface-raised p-1.5 shadow-lg">
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onEdit(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            <span aria-hidden="true" className="w-4 text-center opacity-75">✎</span>
            <span>{t("btn.edit")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onDelete(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            <span aria-hidden="true" className="w-4 text-center opacity-75">🗑</span>
            <span>{t("btn.delete")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function AcpDialogForm({ initial, onCancel, onSave }: {
  initial?: LocalAcpConfig;
  onCancel: () => void;
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
      await onSave({
        id: initial?.id,
        label: label.trim(),
        command: command.trim(),
        args: args.split(/\r?\n/).filter((arg) => arg.length > 0),
      });
      onCancel();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        label={t("settings.agents.acp.name")}
        value={label}
        onChange={(e) => { setLabel(e.target.value); setError(""); }}
        placeholder={t("settings.agents.acp.namePlaceholder")}
        variant="outline"
        autoFocus
      />
      <Input
        label={t("settings.agents.acp.executable")}
        value={command}
        onChange={(e) => { setCommand(e.target.value); setError(""); }}
        placeholder={t("settings.agents.acp.executablePlaceholder")}
        variant="outline"
      />
      <label className="flex flex-col gap-1 text-[12px] font-medium text-gray-700 dark:text-gray-200">
        <span>
          {t("settings.agents.acp.arguments")}{" "}
          <span className="font-normal text-gray-400 dark:text-white/40">· {t("settings.agents.acp.argumentsHint")}</span>
        </span>
        <textarea
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          rows={3}
          placeholder={t("settings.agents.acp.argumentsPlaceholder")}
          className="w-full resize-y rounded-lg border border-gray-300 dark:border-white/15 bg-white dark:bg-surface-raised px-3 py-2 font-mono text-[12px] text-gray-900 dark:text-white outline-none focus:border-accent-500"
        />
      </label>
      <p className="m-0 text-[11.5px] text-amber-700 dark:text-amber-400">{t("settings.agents.acp.safety")}</p>
      {error && <p role="alert" className="m-0 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>{t("btn.cancel")}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? t("settings.agents.acp.saving") : t(initial ? "btn.save" : "btn.add")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Aba Personalizados: junta TUIs de terminal e Agentes ACP numa lista só,
 * com botão "+ Adicionar ▾" e diálogo modal com a escolha de tipo. O formulário deixa de ficar sempre aberto.
 */
export function CustomProvidersSection() {
  const { t } = useTranslation();
  const customAgents = useAgentsStore((s) => s.customAgents);
  const saveCustomAgent = useAgentsStore((s) => s.saveCustomAgent);
  const removeCustomAgent = useAgentsStore((s) => s.removeCustomAgent);

  const acpProviders = useLocalAcpStore((s) => s.providers);
  const acpLoaded = useLocalAcpStore((s) => s.loaded);
  const loadAcp = useLocalAcpStore((s) => s.load);
  const getAcp = useLocalAcpStore((s) => s.get);
  const saveAcp = useLocalAcpStore((s) => s.save);
  const removeAcp = useLocalAcpStore((s) => s.remove);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<{
    open: boolean;
    kind: CustomKind;
    tui?: CustomAgent;
    acp?: LocalAcpConfig;
  }>({ open: false, kind: "tui" });

  useEffect(() => {
    if (!acpLoaded) {
      void loadAcp().catch((error) => AlertaToast(t("settings.agents.acp.title"), String(error), "error", 6000));
    }
  }, [acpLoaded, loadAcp, t]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => { if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAddMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addMenuOpen]);

  const openEditAcp = async (id: string) => {
    try {
      const cfg = await getAcp(id);
      setDialog({ open: true, kind: "acp", acp: cfg });
    } catch (e) {
      AlertaToast(t("settings.agents.acp.title"), String(e), "error", 6000);
    }
  };

  const capabilitiesSummary = (agent: CustomAgent) =>
    [
      agent.resumeArgs && t("settings.tuis.cap.resume"),
      agent.skillsDir && t("settings.tuis.cap.skills"),
      agent.sessionsDir && t("settings.tuis.cap.sessions"),
      Object.keys(agent.env ?? {}).length > 0 && t("settings.tuis.cap.env"),
    ].filter(Boolean).join(" · ");

  const isEditing = Boolean(dialog.tui || dialog.acp);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[13px] text-gray-500 dark:text-white/50">{t("providers.custom.subtitle")}</span>
        <div ref={addMenuRef} className="relative inline-flex shrink-0">
          <Button
            variant="primary"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            + {t("providers.custom.addMenu")} ▾
          </Button>
          {addMenuOpen && (
            <div role="menu" className="absolute right-0 top-[calc(100%+4px)] z-30 w-68 rounded-xl border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-surface-raised p-1.5 shadow-lg">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setAddMenuOpen(false); setDialog({ open: true, kind: "tui" }); }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
              >
                <span aria-hidden="true" className="w-4 text-center opacity-75">⌨︎</span>
                <span className="flex flex-col">
                  <span className="font-medium">{t("providers.custom.type.tui")}</span>
                  <small className="text-[11px] text-gray-400 dark:text-white/45">{t("providers.custom.type.tuiHint")}</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setAddMenuOpen(false); setDialog({ open: true, kind: "acp" }); }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
              >
                <span aria-hidden="true" className="w-4 text-center opacity-75">⇄</span>
                <span className="flex flex-col">
                  <span className="font-medium">{t("providers.custom.type.acp")}</span>
                  <small className="text-[11px] text-gray-400 dark:text-white/45">{t("providers.custom.type.acpHint")}</small>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* TUIs de terminal */}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 mx-0.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-gray-400 dark:text-white/40">
          {t("providers.custom.group.tuis")}
        </h3>
        <SettingsGroup>
          {customAgents.length === 0 ? (
            <div className="px-4 py-5 text-center text-[12.5px] text-gray-400 dark:text-white/40">
              {t("settings.tuis.empty")}
            </div>
          ) : (
            customAgents.map((agent) => {
              const caps = capabilitiesSummary(agent);
              return (
                <div key={agent.id} className="flex items-center gap-3 px-4 py-3">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-[11.5px] font-bold text-white uppercase"
                  >
                    {agent.label.slice(0, 2)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[13.5px] font-semibold text-gray-900 dark:text-white">{agent.label}</div>
                    <div className="truncate text-[12px] text-gray-400 dark:text-white/45">
                      <code className="rounded bg-gray-100 dark:bg-white/[0.08] px-1 py-px font-mono text-[11.5px] text-gray-700 dark:text-gray-200">
                        {agent.command}
                      </code>
                      {caps && <span> · {caps}</span>}
                    </div>
                  </div>
                  <RowMenu
                    label={t("settings.accounts.menu.more", { name: agent.label })}
                    onEdit={() => setDialog({ open: true, kind: "tui", tui: agent })}
                    onDelete={() => {
                      removeCustomAgent(agent.id).catch((e) => AlertaToast(t("btn.delete"), uiErrorText(e), "error", 6000));
                    }}
                  />
                </div>
              );
            })
          )}
        </SettingsGroup>
      </div>

      {/* Agentes ACP */}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 mx-0.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-gray-400 dark:text-white/40">
          {t("providers.custom.group.acp")}
        </h3>
        <SettingsGroup>
          {acpProviders.length === 0 ? (
            <div className="px-4 py-5 text-center text-[12.5px] text-gray-400 dark:text-white/40">
              {t("providers.custom.acpEmpty")}
            </div>
          ) : (
            acpProviders.map((provider) => (
              <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-[11.5px] font-bold text-white uppercase"
                >
                  {provider.label.slice(0, 2)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[13.5px] font-semibold text-gray-900 dark:text-white">{provider.label}</div>
                  <div className="truncate text-[12px] text-gray-400 dark:text-white/45">{t("providers.custom.type.acp")}</div>
                </div>
                <RowMenu
                  label={t("settings.accounts.menu.more", { name: provider.label })}
                  onEdit={() => void openEditAcp(provider.id)}
                  onDelete={() => {
                    removeAcp(provider.id).catch((e) => AlertaToast(t("settings.agents.acp.title"), String(e), "error", 6000));
                  }}
                />
              </div>
            ))
          )}
        </SettingsGroup>
      </div>

      {dialog.open && (
        <AppDialog
          title={isEditing ? t("providers.custom.dialog.editTitle") : t("providers.custom.dialog.addTitle")}
          onClose={() => setDialog({ open: false, kind: "tui" })}
          size="md"
        >
          <div className="flex flex-col gap-3">
            {!isEditing && (
              <div role="radiogroup" aria-label={t("providers.custom.dialog.addTitle")} className="flex gap-1 rounded-lg bg-gray-100 dark:bg-white/[0.06] p-0.5">
                {(["tui", "acp"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={dialog.kind === k}
                    onClick={() => setDialog((d) => ({ ...d, kind: k }))}
                    className={`flex-1 h-7 rounded-md text-[12.5px] font-medium transition-colors
                      ${dialog.kind === k
                        ? "bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-xs"
                        : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}
                  >
                    {t(k === "tui" ? "providers.custom.type.tui" : "providers.custom.type.acp")}
                  </button>
                ))}
              </div>
            )}

            {dialog.kind === "tui" ? (
              <CustomAgentForm
                initial={dialog.tui}
                onCancel={() => setDialog({ open: false, kind: "tui" })}
                onSubmit={async (draft) => {
                  await saveCustomAgent(draft);
                  setDialog({ open: false, kind: "tui" });
                }}
              />
            ) : (
              <AcpDialogForm
                initial={dialog.acp}
                onCancel={() => setDialog({ open: false, kind: "acp" })}
                onSave={async (draft) => {
                  await saveAcp(draft);
                }}
              />
            )}
          </div>
        </AppDialog>
      )}
    </div>
  );
}
