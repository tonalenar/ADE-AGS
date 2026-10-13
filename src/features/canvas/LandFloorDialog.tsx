import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { canLand, conflictPrompt, landState, type BranchInfo, type LandPreview, type LandResult } from "./floorsModel";

export interface LandableFloor {
  id: string;
  name: string;
  branch: string;
  cwd: string;
}

const select = "h-8 px-2 rounded-md text-[12.5px] outline-none bg-white dark:bg-white/8 border border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100";

/**
 * "Aterrissar": leva o trabalho de um andar para a branch do projeto. Mostra o que vai (commits, arquivos,
 * linhas), recusa com o motivo quando há mudanças soltas ou conflito, deixa escolher a branch de destino,
 * apagar a branch e descartar o andar depois, e, no conflito, pede a um agente que o resolva dentro do andar.
 */
export function LandFloorDialog({ floor, groundCwd, onClose, onLanded, onAskAgent }: {
  floor: LandableFloor;
  /** O projeto de onde o andar nasceu: de lá vem a lista de branches de destino. */
  groundCwd: string;
  onClose: () => void;
  onLanded: (result: LandResult) => void;
  /** Abre um agente no andar com este pedido. */
  onAskAgent: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [preview, setPreview] = useState<LandPreview | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [discardFloor, setDiscardFloor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<BranchInfo[]>("floor_branches", { cwd: groundCwd }).then(setBranches).catch(() => setBranches([]));
  }, [groundCwd]);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    invoke<LandPreview>("floor_land_preview", { id: floor.id, target })
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setTarget((cur) => cur ?? p.target);
      })
      .catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [floor.id, target]);

  const state = preview ? landState(preview) : null;

  const land = async () => {
    if (!preview || !canLand(preview) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<LandResult>("floor_land", {
        id: floor.id, target: preview.target, deleteBranch: discardFloor && deleteBranch, discardFloor,
      });
      onLanded(result);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const notice = (tone: "warn" | "info", text: string) => (
    <p className={`rounded-md px-2.5 py-1.5 text-[12px] ${tone === "warn" ? "bg-amber-500/12 text-amber-600 dark:text-amber-300" : "bg-gray-100 dark:bg-white/6 text-gray-600 dark:text-gray-300"}`}>{text}</p>
  );

  return (
    <AppDialog title={t("canvas.floor.land.title", { name: floor.name })} size="md" closeOnEsc onClose={() => !busy && onClose()}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={!canLand(preview) || busy} onClick={() => void land()}>
            {busy ? t("canvas.floor.land.landing") : t("canvas.floor.land.action")}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-3 text-[12.5px] text-gray-700 dark:text-gray-200">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/8">{floor.branch}</code>
          <span aria-hidden>→</span>
          <select className={select} aria-label={t("canvas.floor.land.target")} value={target ?? preview?.target ?? ""} disabled={busy}
            onChange={(e) => setTarget(e.target.value)}>
            {(preview && !branches.some((b) => b.name === preview.target) ? [{ name: preview.target, current: true, inUse: false }, ...branches] : branches)
              .filter((b) => b.name !== floor.branch)
              .map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </div>

        {!preview && !error && <p className="text-gray-400">{t("canvas.floor.land.loading")}</p>}

        {preview && (
          <>
            <p>{t("canvas.floor.land.summary", { commits: preview.ahead, files: preview.filesChanged, added: preview.insertions, removed: preview.deletions })}</p>
            {preview.behind > 0 && notice("info", t("canvas.floor.land.behind", { count: preview.behind, target: preview.target }))}
            {state === "nothing" && notice("info", t("canvas.floor.land.nothing", { target: preview.target }))}
            {state === "dirty" && notice("warn", t("canvas.floor.land.dirty"))}
            {state === "conflict" && (
              <div className="flex flex-col gap-1.5">
                {notice("warn", t("canvas.floor.land.conflict", { count: preview.conflicts.length }))}
                <ul className="max-h-24 overflow-auto cc-scroll font-mono text-[11.5px] text-gray-500 dark:text-gray-400">
                  {preview.conflicts.map((f) => <li key={f} className="truncate" title={f}>{f}</li>)}
                </ul>
                <div>
                  <Button variant="outline" onClick={() => onAskAgent(conflictPrompt(floor.name, preview))}>{t("canvas.floor.land.askAgent")}</Button>
                </div>
              </div>
            )}
            {!preview.conflictsChecked && state === "ready" && notice("info", t("canvas.floor.land.unchecked"))}

            {preview.commits.length > 0 && (
              <ul className="max-h-36 overflow-auto cc-scroll rounded-md border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/6">
                {preview.commits.map((c) => (
                  <li key={c.sha} className="flex gap-2 px-2 py-1">
                    <code className="shrink-0 text-gray-400">{c.sha}</code>
                    <span className="truncate" title={c.subject}>{c.subject}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-1.5 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="size-3.5 accent-accent-500" checked={discardFloor} disabled={busy} onChange={(e) => setDiscardFloor(e.target.checked)} />
                {t("canvas.floor.land.discard")}
              </label>
              <label className={`flex items-center gap-2 ${discardFloor ? "cursor-pointer" : "opacity-40"}`}>
                <input type="checkbox" className="size-3.5 accent-accent-500" checked={discardFloor && deleteBranch} disabled={!discardFloor || busy} onChange={(e) => setDeleteBranch(e.target.checked)} />
                {t("canvas.floor.land.deleteBranch", { branch: floor.branch })}
              </label>
            </div>
          </>
        )}

        {error && <p role="alert" className="text-red-500 whitespace-pre-wrap">{error}</p>}
      </div>
    </AppDialog>
  );
}
