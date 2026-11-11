import { useDisplayPrefs } from "@/features/settings/displayPreferences";

import { effortBars } from "./effortBars";

/**
 * O nível de esforço no botão do composer. Pelo nome (como antes) ou, em "Esforço no composer: Barras",
 * em barras crescentes, uma a mais por nível, com o nome guardado para leitor de tela.
 */
export function EffortLevel({ value, efforts, label }: { value: string; efforts: readonly string[]; label: string }) {
  const display = useDisplayPrefs().effortDisplay;
  const bars = display === "bars" ? effortBars(value, efforts) : null;
  if (!bars) return <>{label}</>;
  return (
    <span role="img" aria-label={label} className="inline-flex items-end gap-px align-middle">
      {Array.from({ length: bars.total }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={`w-[3px] rounded-[1px] ${index < bars.lit ? "bg-current" : "bg-gray-300 dark:bg-white/20"}`}
          style={{ height: `${6 + index * 3}px` }}
        />
      ))}
    </span>
  );
}
