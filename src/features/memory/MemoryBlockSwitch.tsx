import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * Interruptor "incluir memória somente-leitura no início da sessão" da tab interativa. Desligado
 * por padrão. Ligado só manda o índice da memória aprovada como DADOS, uma vez, ao abrir a sessão:
 * nada é escrito em CLAUDE.md nem em AGENTS.md. É um botão nativo (Espaço/Enter alternam, o foco
 * é visível) e a transição respeita reduced-motion.
 */
export function MemoryBlockSwitch({ checked, onChange, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex flex-col gap-0.5 rounded-[10px] bg-white px-3.5 py-3 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] dark:bg-black/20 dark:shadow-[inset_0_0_0_0.5px_rgba(84,84,88,0.55)]">
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="text-[13.5px] leading-[18px] text-gray-900 dark:text-[#f5f5f7]">{t("memoryBlock.label")}</span>
        {/* Switch iOS: 38x22, ligado em verde. */}
        <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelId} aria-describedby={hintId} disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 disabled:opacity-50 ${checked ? "bg-[#34c759] dark:bg-[#30d158]" : "bg-gray-300 dark:bg-surface-overlay"}`}>
          <span aria-hidden="true" className={`absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.35)] transition-transform motion-reduce:transition-none ${checked ? "translate-x-4" : ""}`} />
        </button>
      </div>
      <p id={hintId} className="pr-12 text-[11px] leading-[14px] text-gray-500 dark:text-white/60">
        {t(checked ? "memoryBlock.hintOn" : "memoryBlock.hintOff")}
      </p>
    </div>
  );
}
