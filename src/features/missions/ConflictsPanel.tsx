import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { bothIsSafe, conflictCount, parseConflicts, resolveConflicts, type ConflictChoice } from "./conflicts";
import type { ConflictFile, IntegrationConflicts } from "./conflictsTypes";

/** Un bloque con las dos versiones lado a lado (lo mío a la izquierda, lo del master a la derecha). */
function SideBySide({ ours, theirs, oursLabel, theirsLabel }: { ours: string[]; theirs: string[]; oursLabel: string; theirsLabel: string }) {
  const { t } = useTranslation();
  const col = "min-w-0 flex-1 rounded border border-gray-200 dark:border-white/10";
  const pre = "m-0 max-h-48 overflow-auto p-2 text-[11px] leading-snug font-mono whitespace-pre";
  return (
    <div className="flex gap-2">
      <div className={col}>
        <div className="px-2 py-0.5 text-[10px] font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300">{t("missions.conflicts.mine")} {oursLabel && `(${oursLabel})`}</div>
        <pre className={pre} data-testid="conflict-ours">{ours.join("\n")}</pre>
      </div>
      <div className={col}>
        <div className="px-2 py-0.5 text-[10px] font-semibold bg-violet-500/10 text-violet-700 dark:text-violet-300">{t("missions.conflicts.master")} {theirsLabel && `(${theirsLabel})`}</div>
        <pre className={pre} data-testid="conflict-theirs">{theirs.join("\n")}</pre>
      </div>
    </div>
  );
}

function FileCard({ file, onResolve }: { file: ConflictFile; onResolve: (content: string) => void | Promise<void> }) {
  const { t } = useTranslation();
  const parsed = parseConflicts(file.content);
  const blocks = parsed.segments.filter((s) => s.kind === "conflict");
  const [choices, setChoices] = useState<Record<number, ConflictChoice>>({});
  const safeBoth = bothIsSafe(file.path);
  const unsupported = file.binary || parsed.malformed;
  const complete = blocks.every((_, i) => choices[i] !== undefined);
  const result = !unsupported && complete ? resolveConflicts(file.path, file.content, "ours", choices) : null;
  const choose = (i: number, c: ConflictChoice) => setChoices((prev) => ({ ...prev, [i]: c }));
  const all = (c: ConflictChoice) => setChoices(Object.fromEntries(blocks.map((_, i) => [i, c])));
  const btn = (active: boolean) => `px-2 h-6 rounded text-[10.5px] font-medium ${active ? "bg-accent-500/20 text-accent-700 dark:text-accent-300" : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/5"}`;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-white/8 p-3" data-testid="conflict-file">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-[11.5px] font-semibold text-gray-800 dark:text-gray-100">{file.path}</span>
        <span className="shrink-0 text-[10.5px] text-gray-500 dark:text-white/45">{t("missions.conflicts.blocks", { count: conflictCount(parsed) })}</span>
        <span className="flex-1" />
        {!unsupported && (
          <>
            <Button variant="custom" className={btn(false)} onClick={() => all("ours")}>{t("missions.conflicts.allMine")}</Button>
            <Button variant="custom" className={btn(false)} onClick={() => all("theirs")}>{t("missions.conflicts.allMaster")}</Button>
            {safeBoth && <Button variant="custom" className={btn(false)} onClick={() => all("both")}>{t("missions.conflicts.allBoth")}</Button>}
          </>
        )}
      </div>

      {unsupported ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">{t(file.binary ? "missions.conflicts.binary" : "missions.conflicts.malformed")}</p>
      ) : (
        <>
          {!safeBoth && <p className="text-[10.5px] text-gray-500 dark:text-white/45">{t("missions.conflicts.codeHint")}</p>}
          {blocks.map((b, i) => b.kind === "conflict" && (
            <div key={i} className="flex flex-col gap-1">
              <SideBySide ours={b.ours} theirs={b.theirs} oursLabel={b.oursLabel} theirsLabel={b.theirsLabel} />
              <div className="flex gap-1">
                <Button variant="custom" className={btn(choices[i] === "ours")} onClick={() => choose(i, "ours")}>{t("missions.conflicts.keepMine")}</Button>
                <Button variant="custom" className={btn(choices[i] === "theirs")} onClick={() => choose(i, "theirs")}>{t("missions.conflicts.keepMaster")}</Button>
                {safeBoth && <Button variant="custom" className={btn(choices[i] === "both")} onClick={() => choose(i, "both")}>{t("missions.conflicts.keepBoth")}</Button>}
              </div>
            </div>
          ))}
          {result && !result.valid && <p className="text-[11px] text-red-600 dark:text-red-400">{t("missions.conflicts.invalidJson")}</p>}
          <div className="flex justify-end">
            <Button variant="primary" size="sm" disabled={!result || !result.valid} onClick={() => result && onResolve(result.content)}>
              {t("missions.conflicts.apply")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Los archivos en conflicto del merge de integración, por props (el contenedor llama a los comandos). */
export function ConflictsPanel({ conflicts, onResolve, onConclude }: {
  conflicts: IntegrationConflicts;
  onResolve: (path: string, content: string) => void | Promise<void>;
  onConclude: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="conflicts-panel">
      <p className="text-[11.5px] text-gray-600 dark:text-white/55">
        {t("missions.conflicts.intro", { branch: conflicts.branch, against: conflicts.against, count: conflicts.files.length })}
      </p>
      {conflicts.files.map((f) => <FileCard key={f.path} file={f} onResolve={(c) => onResolve(f.path, c)} />)}
      {conflicts.files.length === 0 && (
        <div className="flex items-center gap-3">
          <p className="text-[11.5px] text-emerald-600 dark:text-emerald-400">{t("missions.conflicts.none")}</p>
          <Button variant="primary" size="sm" onClick={() => onConclude()}>{t("missions.conflicts.conclude")}</Button>
        </div>
      )}
    </div>
  );
}
