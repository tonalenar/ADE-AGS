import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import {
  createCheckpoint, restorable, restoreCheckpoint, rollbackPreview, rollbackTask, runCheckpoints,
  type Checkpoint, type RollbackPreview,
} from "./checkpoints";
import type { Task } from "./types";

const when = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * "Volver a antes de esta tarea": muestra qué se rehace (la tarea, lo que depende de ella y lo
 * que corrió después en su carpeta) y qué carpetas se restauran, y pide confirmar. Antes de
 * restaurar se guarda una foto de seguridad: abajo se ven las que hay, para deshacer.
 */
export function RollbackDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: (text: string, error: boolean) => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Checkpoint[]>([]);
  const [busy, setBusy] = useState(false);

  const loadPhotos = () => runCheckpoints(task.runId).then((l) => setPhotos(restorable(l))).catch(() => setPhotos([]));
  useEffect(() => {
    rollbackPreview(task.id).then(setPreview).catch((e) => setProblem(String(e)));
    void loadPhotos();
    // Al abrir el diálogo, para esta tarea.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const run = async (action: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    try {
      await action();
      onDone(okText, false);
      onClose();
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      onClose={onClose}
      title={t("fleet.rollback.title")}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="danger" disabled={!preview || busy}
            onClick={() => void run(() => rollbackTask(task.id), t("fleet.rollback.done", { count: preview?.tasks.length ?? 1 }))}>
            {busy ? "…" : t("fleet.rollback.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-gray-600 dark:text-gray-300">
        {t("fleet.rollback.intro", { title: task.title })}
      </p>

      {problem && <p className="mt-3 text-[12px] text-red-500 dark:text-red-400">{problem}</p>}

      {preview && (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/35">{t("fleet.rollback.tasks")}</div>
            <ul className="text-[12.5px] text-gray-700 dark:text-gray-200">
              {preview.tasks.map((p) => (
                <li key={p.id} className="flex items-center gap-2 py-0.5">
                  <span className="truncate">{p.title}</span>
                  <span className="shrink-0 text-[10.5px] text-gray-400">{t(`fleet.rollback.status.${p.status}`, { defaultValue: p.status })}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/35">{t("fleet.rollback.dirs")}</div>
            {preview.dirs.map((d) => <code key={d} className="block truncate text-[11px] text-gray-500 dark:text-gray-400" title={d}>{d}</code>)}
          </div>
          {preview.withoutCheckpoint.length > 0 && (
            <p className="text-[11.5px] text-amber-600 dark:text-amber-400">{t("fleet.rollback.noPhoto", { count: preview.withoutCheckpoint.length })}</p>
          )}
          <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/40">{t("fleet.rollback.safety")}</p>
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-gray-200 dark:border-white/8">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/35">{t("fleet.rollback.photos")}</span>
          <Button variant="outline" size="sm" disabled={busy}
            onClick={() => createCheckpoint(task.runId, "").then(() => loadPhotos()).catch((e) => setProblem(String(e)))}>
            {t("fleet.rollback.create")}
          </Button>
        </div>
        {photos.length === 0 ? (
          <p className="text-[11.5px] text-gray-400 dark:text-white/35">{t("fleet.rollback.noPhotos")}</p>
        ) : (
          photos.slice(0, 6).map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-1">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-gray-700 dark:text-gray-200">{c.label || t(`fleet.rollback.kind.${c.kind}`)}</div>
                <div className="text-[10.5px] text-gray-400 dark:text-white/35">{t(`fleet.rollback.kind.${c.kind}`)} · {when(c.createdAt)}</div>
              </div>
              <Button variant="outline" size="sm" disabled={busy}
                onClick={() => void run(() => restoreCheckpoint(c.id), t("fleet.rollback.restored"))}>
                {t("fleet.rollback.restore")}
              </Button>
            </div>
          ))
        )}
      </div>
    </AppDialog>
  );
}
