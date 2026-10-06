import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import {
  acceptMissionTask, applyMission, missionReview, missionTaskDiff, rejectMissionTask,
} from "./ipc";
import { ConflictsSection } from "./ConflictsSection";
import type { Delivery, MergeOutcome, MissionReview } from "./types";

const REVIEW_VARIANT = { accepted: "success", rejected: "neutral", conflict: "danger" } as const;

/**
 * Revisar lo que entregó cada tarea aislada y llevarlo al proyecto (ver `missions::review`).
 *
 * Aceptar junta la rama de la tarea en la integración de la misión, no en la copia de
 * trabajo del usuario. Aplicar es un único merge de esa integración en el proyecto. Un
 * conflicto se aborta y se muestra: nada queda a mitad de un merge.
 */
export function MissionReviewPanel({ missionId, refreshKey }: { missionId: string; refreshKey: string }) {
  const { t } = useTranslation();
  const [review, setReview] = useState<MissionReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; conflict?: boolean } | null>(null);
  const [diffFor, setDiffFor] = useState<Delivery | null>(null);
  const [resolving, setResolving] = useState(false);

  const load = useCallback(() => {
    missionReview(missionId).then(setReview).catch((e) => setMessage({ tone: "error", text: String(e) }));
  }, [missionId]);
  useEffect(load, [load, refreshKey]);

  const describe = (outcome: MergeOutcome, ok: string) =>
    outcome.result === "Merged"
      ? { tone: "ok" as const, text: `${ok} (${outcome.commit})` }
      : { tone: "error" as const, text: t("missions.review.conflict", { files: outcome.files.join(", ") }), conflict: true };

  const act = async (key: string, run: () => Promise<{ tone: "ok" | "error"; text: string; conflict?: boolean } | null>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage(await run());
    } catch (e) {
      setMessage({ tone: "error", text: String(e) });
    } finally {
      setBusy(null);
      load();
    }
  };

  if (!review || review.deliveries.length === 0) return null;

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-white/30">
          {t("missions.review.title")}
        </h3>
        {review.appliedAt !== null && review.pendingCommits === 0 ? (
          <Badge variant="success" size="sm">{t("missions.review.applied")}</Badge>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null || review.pendingCommits === 0}
            onClick={() => act("apply", async () => describe(await applyMission(missionId), t("missions.review.appliedOk")))}
          >
            {t("missions.review.apply", { n: review.pendingCommits })}
          </Button>
        )}
      </div>

      {message && (
        <p className={`text-[11px] ${message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
          {message.text}
        </p>
      )}

      {message?.conflict && !resolving && (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setResolving(true)}>
          {t("missions.conflicts.resolve")}
        </Button>
      )}
      {resolving && <ConflictsSection missionId={missionId} onDone={() => { setResolving(false); setMessage(null); load(); }} />}

      <ul className="flex flex-col divide-y divide-gray-100 dark:divide-white/5 rounded-lg border border-gray-200 dark:border-white/8">
        {review.deliveries.map((d) => {
          const added = d.files.reduce((n, f) => n + (f.added ?? 0), 0);
          const removed = d.files.reduce((n, f) => n + (f.removed ?? 0), 0);
          const decided = d.review === "accepted" || d.review === "rejected";
          return (
            <li key={d.taskId} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-gray-800 dark:text-gray-200" title={d.branch}>
                  {d.title}
                </span>
                {d.review && (
                  <Badge variant={REVIEW_VARIANT[d.review as keyof typeof REVIEW_VARIANT] ?? "neutral"} size="sm">
                    {t(`missions.review.state.${d.review}`)}
                  </Badge>
                )}
              </div>
              <span className="text-[10.5px] tabular-nums text-gray-400 dark:text-white/35">
                {t("missions.review.stats", { files: d.files.length, commits: d.commits.length })}
                {" · "}
                <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
                {" "}
                <span className="text-red-500 dark:text-red-400">−{removed}</span>
              </span>
              {d.uncommitted.length > 0 && (
                <span className="text-[10.5px] text-amber-700 dark:text-amber-400">
                  {t("missions.review.uncommitted", { files: d.uncommitted.join(", ") })}
                </span>
              )}
              {d.review === "conflict" && d.reviewNote && (
                <span className="text-[10.5px] text-red-500 dark:text-red-400">
                  {t("missions.review.conflict", { files: d.reviewNote.split("\n").join(", ") })}
                </span>
              )}
              <div className="flex items-center gap-1.5 pt-0.5">
                <Button size="sm" variant="outline" onClick={() => setDiffFor(d)}>{t("missions.review.diff")}</Button>
                {!decided && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || d.uncommitted.length > 0 || d.files.length === 0}
                      onClick={() => act(d.taskId, async () => describe(await acceptMissionTask(missionId, d.taskId), t("missions.review.acceptedOk")))}
                    >
                      {t("missions.review.accept")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => act(d.taskId, async () => { await rejectMissionTask(missionId, d.taskId); return null; })}
                    >
                      {t("missions.review.reject")}
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {diffFor && <DiffDialog delivery={diffFor} onClose={() => setDiffFor(null)} />}
    </section>
  );
}

/** El diff de una entrega contra el proyecto, coloreado por línea. */
function DiffDialog({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    missionTaskDiff(delivery.taskId).then(setDiff).catch((e) => setError(String(e)));
  }, [delivery.taskId]);

  const tone = (line: string) =>
    line.startsWith("+") && !line.startsWith("+++") ? "text-emerald-700 dark:text-emerald-400"
      : line.startsWith("-") && !line.startsWith("---") ? "text-red-600 dark:text-red-400"
        : line.startsWith("@@") ? "text-blue-600 dark:text-blue-400"
          : line.startsWith("diff ") ? "font-semibold text-gray-800 dark:text-gray-100"
            : "text-gray-500 dark:text-gray-400";

  return (
    <AppDialog title={t("missions.review.diffTitle", { title: delivery.title })} onClose={onClose} size="lg">
      {error && <p className="text-[11.5px] text-red-500 dark:text-red-400">{error}</p>}
      {diff === null && !error && <p className="text-[11.5px] text-gray-400">…</p>}
      {diff !== null && (
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-gray-50 dark:bg-black/30 p-3 text-[11px] leading-[1.45] font-mono">
          {diff.split("\n").map((line, i) => (
            <div key={i} className={tone(line)}>{line || " "}</div>
          ))}
        </pre>
      )}
    </AppDialog>
  );
}
