import { accountBadgeStyle, accountInitials } from "@/features/accounts/accountIdentity";

const SIZE = {
  sm: "w-4 h-4 text-[7.5px] rounded-[4px]",
  md: "w-6 h-6 text-[10px] rounded-md",
} as const;

/**
 * O selo de uma conta: as iniciais do nome sobre a cor escolhida (token do tema). Sem cor, fica
 * cinza neutro. Decorativo quando há texto ao lado; passe `label` para virar uma imagem nomeada.
 */
export function AccountBadge({ label, accentColor, size = "md", named = false, className = "" }: {
  label: string;
  accentColor?: string | null;
  size?: keyof typeof SIZE;
  /** `true` quando o selo está sozinho (um ícone de trilho): expõe o nome para leitores de tela. */
  named?: boolean;
  className?: string;
}) {
  const style = accountBadgeStyle(accentColor);
  const neutral = style ? "" : "bg-gray-200 text-gray-600 dark:bg-white/12 dark:text-gray-300";
  return (
    <span
      data-account-badge=""
      role={named ? "img" : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
      style={style}
      className={`inline-flex items-center justify-center shrink-0 font-semibold leading-none
        select-none ${SIZE[size]} ${neutral} ${className}`}
    >
      {accountInitials(label)}
    </span>
  );
}
