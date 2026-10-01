import { useTranslation } from "react-i18next";
import type { StructuredHandoff, Task } from "./types";

/** Worker data is always rendered as text, never HTML, markdown or executable links. */
export function HandoffView({ task }: { task: Pick<Task, "handoff" | "structuredHandoff"> }) {
  const { t } = useTranslation();
  const handoff = task.structuredHandoff;
  if (!handoff && !task.handoff) return null;
  return (
    <div className="text-[11px] text-gray-600 dark:text-white/60 whitespace-pre-wrap break-words">
      {handoff && (
        <details className="rounded border border-gray-200 dark:border-white/10 p-2">
          <summary className="cursor-pointer font-semibold">{t("handoff.title")} · v{handoff.version}</summary>
          <p className="mt-2"><strong>{t("handoff.summary")}: </strong>{handoff.summary}</p>
          {sections(handoff).filter((section) => section.lines.length > 0).map((section) => (
            <details key={section.key} className="mt-2">
              <summary className="cursor-pointer font-medium">{t(`handoff.${section.key}`)} ({section.lines.length})</summary>
              <ul className="list-disc pl-4">{section.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
            </details>
          ))}
        </details>
      )}
      {task.handoff && (
        <details className="mt-2 rounded border border-gray-200 dark:border-white/10 p-2">
          <summary className="cursor-pointer font-semibold">{t("handoff.legacy")}</summary>
          <p className="mt-2">{task.handoff}</p>
        </details>
      )}
    </div>
  );

  function sections(value: StructuredHandoff) {
    return [
      { key: "files", lines: value.changed_files.map((file) => `${file.path}${file.description ? ` — ${file.description}` : ""}`) },
      { key: "tests", lines: value.tests.map((test) => `${test.command} — ${t(`handoff.status.${test.status}`)}${test.notes ? ` — ${test.notes}` : ""}`) },
      { key: "decisions", lines: value.decisions },
      { key: "risks", lines: value.risks },
      { key: "nextSteps", lines: value.next_steps },
      { key: "artifacts", lines: value.artifacts.map((artifact) => `${artifact.label} — ${artifact.path}`) },
    ];
  }
}
