import { Button } from "neogestify-ui-components";

import { AppDialog } from "./AppDialog";
import { answerConfirm, useConfirmStore } from "./appConfirm";

/** Mostra, uma de cada vez, as confirmações pedidas com `appConfirm`. Montado uma vez no shell. */
export function AppConfirmHost() {
  const current = useConfirmStore((s) => s.queue[0]);
  if (!current) return null;
  const danger = current.tone === "danger";
  return (
    <AppDialog
      title={current.title}
      size="sm"
      variant={danger ? "danger" : "warning"}
      closeOnEsc
      onClose={() => answerConfirm(false)}
      footer={
        <>
          <Button variant="outline" onClick={() => answerConfirm(false)}>{current.cancelLabel}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={() => answerConfirm(true)}>{current.confirmLabel}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13.5px] leading-[20px] text-gray-800 dark:text-white/85">{current.lead}</p>
        {current.items && current.items.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {current.items.map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[12px] font-medium
                bg-amber-500/12 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/25">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {item}
              </li>
            ))}
          </ul>
        )}
        {current.note && (
          <p className="text-[12.5px] leading-[19px] text-gray-500 dark:text-white/55">{current.note}</p>
        )}
      </div>
    </AppDialog>
  );
}
