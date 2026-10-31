import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { aiMemoryHandoffs } from "@/features/memory/aiMemoryIpc";
import type { AiMemoryHandoff } from "@/features/memory/aiMemory";
import { getSetting } from "@/shared/ipc/settings";
import { AppDialog } from "@/shared/ui/AppDialog";
import type { AgentInfo, Tab } from "./types";
import { pendingForClaude } from "./continuity";

/** O diálogo não cria aba/PTY e não chama accept. Só o clique final autoriza abrir. */
export function ContinueAgentDialog({ source, claude, onClose, onContinue }: {
  source: Tab; claude?: AgentInfo; onClose: () => void;
  onContinue: (agent: AgentInfo, withRun: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AiMemoryHandoff[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (await getSetting("ai_memory_tabs_enabled") === "false") {
          if (active) { setDisabled(true); setRows([]); }
          return;
        }
        const result = await aiMemoryHandoffs(source.cwd);
        if (active) setRows(pendingForClaude(result.data, source.cwd));
      } catch (e) { if (active) setError(String(e)); }
    })();
    return () => { active = false; };
  }, [source.cwd]);
  const launch = async () => {
    if (!claude?.available || !rows || busy) return;
    setBusy(true);
    try { await onContinue(claude, rows.length > 0); onClose(); }
    catch (e) { setError(String(e)); setBusy(false); }
  };
  return (
    <AppDialog title={t("continuity.title")} size="md" onClose={onClose} closeOnEsc footer={<>
      <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
      <Button disabled={!claude?.available || rows === null || !!error || busy} onClick={() => { void launch(); }}>
        {t("continuity.confirm", { agent: "Claude" })}
      </Button>
    </>}>
      <div className="space-y-3 text-sm">
        <p>{t("continuity.originStays")}</p>
        <code className="block break-all">{source.cwd}</code>
        <p>{t("continuity.untrusted")}</p>
        {error && <p role="alert">{error}</p>}
        {rows === null && !error && <p>{t("continuity.loading")}</p>}
        {disabled && <p>{t("continuity.disabled")}</p>}
        {rows?.length === 0 && !disabled && <p>{t("continuity.empty")}</p>}
        {!!rows?.length && <>
          <p>{t("continuity.previewNote")}</p>
          <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="break-all rounded border border-gray-200 p-2 dark:border-white/10">
            <span>{row.from_agent}</span>{" · "}<code>{row.id}</code>
            {row.cwd && <div>{row.cwd}</div>}
          </li>)}</ul>
          <p>{t("continuity.claimNote")}</p>
        </>}
        {!claude?.available && <p>{t("continuity.claudeMissing")}</p>}
        <div className="space-y-1">
          {["Codex", "OpenCode"].map((agent) => <div key={agent}>
            <button type="button" disabled className="opacity-50">{t("continuity.confirm", { agent })}</button>
            <p className="text-xs text-gray-500">{t("continuity.unsupported")}</p>
          </div>)}
        </div>
      </div>
    </AppDialog>
  );
}
