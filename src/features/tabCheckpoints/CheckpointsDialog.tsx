import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Button, Switch } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { AppDialog } from "@/shared/ui/AppDialog";
import { appConfirm } from "@/shared/ui/appConfirm";

import {
  AUTO_SETTING, CHANGED_EVENT, tabCheckpointCreate, tabCheckpointDiff, tabCheckpointRestore,
  tabCheckpointsDelete, tabCheckpointsList,
} from "./ipc";
import { authorKey, describeBlockers, diffTone, kindKey } from "./model";
import type { CheckpointDiff, TabCheckpoint } from "./types";

const TONE: Record<ReturnType<typeof diffTone>, string> = {
  add: "text-emerald-700 dark:text-emerald-400",
  del: "text-red-600 dark:text-red-400",
  hunk: "text-blue-600 dark:text-blue-400",
  file: "font-semibold text-gray-800 dark:text-gray-100",
  plain: "text-gray-500 dark:text-gray-400",
};

/**
 * Os pontos de restauração de uma aba: a linha do tempo, "Ver diff desde aqui" e "Voltar até aqui".
 * Voltar reescreve só os ARQUIVOS da pasta; a conversa do agente não volta, e o diálogo diz isso.
 */
export function CheckpointsDialog({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [list, setList] = useState<TabCheckpoint[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [diffFor, setDiffFor] = useState<TabCheckpoint | null>(null);

  const reload = useCallback(() => {
    tabCheckpointsList(tab.id).then(setList).catch((e) => setError(String(e)));
  }, [tab.id]);

  useEffect(() => {
    reload();
    getSetting(AUTO_SETTING).then((v) => setAuto(v !== "0" && v !== "false")).catch(() => undefined);
    const off = listen<{ tabId: string }>(CHANGED_EVENT, (e) => { if (e.payload.tabId === tab.id) reload(); });
    return () => { off.then((fn) => fn()); };
  }, [tab.id, reload]);

  const run = async (key: string, job: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try { await job(); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };

  const mark = () => run("mark", async () => {
    const out = await tabCheckpointCreate(tab.id, tab.cwd);
    setNotice(out.status === "created" ? t("tabCheckpoints.marked", { seq: out.checkpoint.seq })
      : out.status === "unchanged" ? t("tabCheckpoints.unchanged", { seq: out.checkpoint.seq })
        : t("tabCheckpoints.notRepo"));
    reload();
  });

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    setSetting(AUTO_SETTING, on ? "1" : "0").catch((e) => setError(String(e)));
  };

  const restore = (cp: TabCheckpoint) => run(cp.id, async () => {
    const ok = await appConfirm({
      title: t("tabCheckpoints.restore.title", { seq: cp.seq }),
      lead: t("tabCheckpoints.restore.lead", { dir: cp.repoRoot }),
      items: cp.message ? [cp.message] : undefined,
      note: t("tabCheckpoints.restore.note"),
      confirmLabel: t("tabCheckpoints.restore.confirm"),
      cancelLabel: t("btn.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    let out = await tabCheckpointRestore(cp.id, false);
    if (out.blockers.length > 0 && !out.safety) {
      const lines = describeBlockers(out.blockers, useTabsStore.getState().tabs);
      const force = await appConfirm({
        title: t("tabCheckpoints.shared.title"),
        lead: t("tabCheckpoints.shared.lead"),
        items: lines.map((l) => (l.kind === "tab" ? t("tabCheckpoints.shared.tab", { name: l.name, dir: l.dir })
          : t("tabCheckpoints.shared.task", { name: l.name, dir: l.dir }))),
        note: t("tabCheckpoints.shared.note"),
        confirmLabel: t("tabCheckpoints.shared.confirm"),
        cancelLabel: t("btn.cancel"),
        tone: "danger",
      });
      if (!force) return;
      out = await tabCheckpointRestore(cp.id, true);
    }
    const report = out.report;
    if (report) {
      const base = t("tabCheckpoints.restored", { seq: cp.seq, written: report.written, deleted: report.deleted, safety: out.safety?.seq ?? "?" });
      setNotice(report.failed.length > 0 ? `${base} ${t("tabCheckpoints.failed", { files: report.failed.join(", ") })}` : base);
    }
    reload();
  });

  const removeAll = () => run("delete", async () => {
    const ok = await appConfirm({
      title: t("tabCheckpoints.delete.title"),
      lead: t("tabCheckpoints.delete.lead"),
      confirmLabel: t("tabCheckpoints.delete.confirm"),
      cancelLabel: t("btn.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    await tabCheckpointsDelete(tab.id);
    setNotice("");
    reload();
  });

  const when = (ms: number) => new Date(ms).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "medium" });

  return (
    <>
      <AppDialog title={t("tabCheckpoints.title", { name: tab.title || tab.agentLabel })} onClose={onClose} size="lg" closeOnEsc>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("tabCheckpoints.explain")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={mark} disabled={busy !== null}>{t("tabCheckpoints.mark")}</Button>
            <Switch checked={auto} onChange={toggleAuto} label={t("tabCheckpoints.auto")} />
            <span className="flex-1" />
            {list && list.length > 0 && (
              <Button size="sm" variant="ghost" onClick={removeAll} disabled={busy !== null}>{t("tabCheckpoints.delete.button")}</Button>
            )}
          </div>
          {notice && <p className="text-[11.5px] text-emerald-700 dark:text-emerald-400">{notice}</p>}
          {error && <p className="text-[11.5px] text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</p>}
          {list === null && !error && <p className="text-[11.5px] text-gray-400">…</p>}
          {list && list.length === 0 && <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("tabCheckpoints.empty")}</p>}
          {list && list.length > 0 && (
            <ol className="flex flex-col divide-y divide-black/5 dark:divide-white/10 max-h-[55vh] overflow-auto rounded-md border border-black/5 dark:border-white/10">
              {list.map((cp) => (
                <li key={cp.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="font-mono text-[11px] text-gray-400 w-8 shrink-0">#{cp.seq}</span>
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="truncate text-gray-800 dark:text-gray-100" title={cp.message}>{cp.message || t(kindKey(cp.kind))}</span>
                    <span className="text-[10.5px] text-gray-400 dark:text-white/40">
                      {t(kindKey(cp.kind))} · {t(authorKey(cp.author))} · {when(cp.createdAt)}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setDiffFor(cp)} disabled={busy !== null}>{t("tabCheckpoints.diff")}</Button>
                  <Button size="sm" variant="danger" onClick={() => restore(cp)} disabled={busy !== null}>{t("tabCheckpoints.restore.button")}</Button>
                </li>
              ))}
            </ol>
          )}
          {list && list.length > 0 && (
            <p className="text-[10.5px] font-mono text-gray-400 dark:text-white/35 truncate" title={list[0].repoRoot}>{list[0].repoRoot}</p>
          )}
        </div>
      </AppDialog>
      {diffFor && <DiffDialog checkpoint={diffFor} onClose={() => setDiffFor(null)} />}
    </>
  );
}

function DiffDialog({ checkpoint, onClose }: { checkpoint: TabCheckpoint; onClose: () => void }) {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    tabCheckpointDiff(checkpoint.id).then(setDiff).catch((e) => setError(String(e)));
  }, [checkpoint.id]);

  return (
    <AppDialog title={t("tabCheckpoints.diffTitle", { seq: checkpoint.seq })} onClose={onClose} size="lg" closeOnEsc>
      {error && <p className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
      {diff === null && !error && <p className="text-[11.5px] text-gray-400">…</p>}
      {diff !== null && !diff.patch.trim() && <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("tabCheckpoints.noDiff")}</p>}
      {diff !== null && diff.patch.trim() && (
        <div className="flex flex-col gap-2">
          <pre className="rounded-md bg-gray-50 dark:bg-black/30 p-3 text-[11px] leading-[1.45] font-mono text-gray-600 dark:text-gray-300 overflow-auto max-h-[20vh]">{diff.stat}</pre>
          <pre className="max-h-[50vh] overflow-auto rounded-md bg-gray-50 dark:bg-black/30 p-3 text-[11px] leading-[1.45] font-mono">
            {diff.patch.split("\n").map((line, i) => (
              <div key={i} className={TONE[diffTone(line)]}>{line || " "}</div>
            ))}
          </pre>
          {diff.truncated && <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("tabCheckpoints.truncated")}</p>}
        </div>
      )}
    </AppDialog>
  );
}
