import { useTranslation } from "react-i18next";

import { DesignPanel } from "@/features/canvas/design/DesignPanel";
import { useScopedDesigns } from "@/features/canvas/design/useScopedDesigns";

import { setRightPanel } from "./store";

/**
 * A aba "Design" do painel direito (prancheta 8): as pranchetas que o agente desenhou para a pasta da
 * conversa, para ver, comentar e aprovar sem sair do chat. É o mesmo painel do canvas.
 */
export function DesignPane({ cwd }: { cwd: string | null }) {
  const { t } = useTranslation();
  const design = useScopedDesigns({ cwd, missionId: null });
  if (design.details.length === 0) {
    return <p className="p-4 text-[13px] leading-snug text-gray-400 dark:text-white/40">{t("chat.design.empty")}</p>;
  }
  return (
    <div className="relative h-full">
      <DesignPanel details={design.details} reload={design.reload} onClose={() => setRightPanel("diff")} />
    </div>
  );
}
