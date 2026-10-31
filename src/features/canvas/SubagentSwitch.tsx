import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * O interruptor "Subagente": apoio do orquestrador, que só executa o que ele mandar. É o mesmo do
 * canvas (`RolePicker`) e do formulário "Ligar ao time" do modo chat.
 */
export function SubagentSwitch({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  const { t } = useTranslation();
  const switchId = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] bg-white px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] dark:bg-black/20 dark:shadow-[inset_0_0_0_0.5px_rgba(84,84,88,0.55)]">
      <span className="min-w-0">
        <span id={switchId} className="block text-[13px] leading-[17px] text-gray-900 dark:text-[#f5f5f7]">{t("role.subagent")}</span>
        <span className="block text-[11px] leading-[14px] text-gray-500 dark:text-white/60">{t("role.subagentHint")}</span>
      </span>
      <button type="button" role="switch" aria-checked={value} aria-labelledby={switchId}
        onClick={() => onChange(!value)}
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${value ? "bg-[#34c759] dark:bg-[#30d158]" : "bg-gray-300 dark:bg-surface-overlay"}`}>
        <span aria-hidden="true" className={`absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.35)] transition-transform motion-reduce:transition-none ${value ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}
