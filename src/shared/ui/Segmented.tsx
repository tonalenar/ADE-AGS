/**
 * O controle segmentado das pranchetas (`.seg`): um trilho cinza com o item ativo "erguido".
 * Mesma API de leitura do `SegmentedControl` da biblioteca, mas no desenho aprovado: trilho de
 * 2px de respiro, raio 8, itens de 24px, o ativo em cinza mais claro com sombra fina.
 */
export function Segmented<T extends string>({ value, onChange, options, label, className = "" }: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  /** O nome do grupo para leitores de tela. */
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className={`inline-flex shrink-0 rounded-lg bg-black/[0.05] p-0.5 dark:bg-surface-raised ${className}`}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(option.value)}
            className={`h-6 min-w-0 flex-1 whitespace-nowrap rounded-md px-3 text-[12.5px] leading-4 transition-colors ${on
              ? "bg-white font-medium text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.15),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:bg-surface-overlay dark:text-[#f5f5f7] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(255,255,255,0.06)]"
              : "text-gray-500 hover:text-gray-900 dark:text-white/60 dark:hover:text-white"}`}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
