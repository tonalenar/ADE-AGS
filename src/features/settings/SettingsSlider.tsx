/**
 * Um controle deslizante com o valor à direita, dentro de uma linha de ajuste. É o mesmo visual para o
 * contraste e o vidro (Aparência → Interface) e para os tamanhos das fontes (Aparência → Tipografia).
 */
export function SliderRow({ id, label, hint, min, max, value, format, onChange }: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[14px] font-medium text-gray-900 dark:text-white">{label}</span>
          <span className="text-[13px] text-gray-500 dark:text-white/50">{hint}</span>
        </label>
        <output htmlFor={id} className="shrink-0 font-mono text-chat-caption tabular-nums text-gray-600 dark:text-white/65">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent-600"
      />
    </div>
  );
}
