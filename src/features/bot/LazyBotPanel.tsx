import { lazy, Suspense, useState } from "react";

import { useBotPanelStore } from "./botPanelStore";

/**
 * O painel do bot (LiveArcade, inbox de memória, custos) só depois da primeira abertura: antes ia no
 * entry e os hooks dele (pet, conversas ao vivo) rodavam com o painel fechado. Depois de aberto uma
 * vez fica montado, para guardar a aba e a missão escolhidas.
 */
const Impl = lazy(() => import("./BotPanel").then((m) => ({ default: m.BotPanel })));

export function BotPanel() {
  const open = useBotPanelStore((s) => s.open);
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <Impl />
    </Suspense>
  );
}
