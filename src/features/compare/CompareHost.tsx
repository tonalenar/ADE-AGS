import { Suspense, lazy } from "react";

import { useCompareStore } from "./store";

const CompareDialog = lazy(() => import("./CompareDialog").then((m) => ({ default: m.CompareDialog })));
const DiffDialog = lazy(() => import("./DiffDialog").then((m) => ({ default: m.DiffDialog })));

/** Monta, uma vez no shell, o diálogo "Comparar modelos" e o diff de um modelo, quando abertos. */
export function CompareHost() {
  const dialog = useCompareStore((s) => s.dialog);
  const diff = useCompareStore((s) => s.diff);
  return (
    <Suspense fallback={null}>
      {dialog && <CompareDialog initialCwd={dialog.cwd} />}
      {diff && <DiffDialog comparisonId={diff.comparisonId} pick={diff.pick} />}
    </Suspense>
  );
}
