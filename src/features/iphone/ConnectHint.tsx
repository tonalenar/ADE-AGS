import { useTranslation } from "react-i18next";

/** As cores de cada lugar: a barra escura do canvas (`dark`) ou o painel do chat, claro ou escuro (`panel`). */
export type Tone = "dark" | "panel";

const TEXT: Record<Tone, { title: string; body: string; step: string; art: string; flow: string; label: string }> = {
  dark: {
    title: "text-white",
    body: "text-white/60",
    step: "text-white/70",
    art: "text-white/55",
    flow: "text-accent-300",
    label: "text-white/45",
  },
  panel: {
    title: "text-gray-900 dark:text-white",
    body: "text-gray-500 dark:text-white/55",
    step: "text-gray-600 dark:text-white/70",
    art: "text-gray-400 dark:text-white/45",
    flow: "text-accent-500 dark:text-accent-300",
    label: "text-gray-400 dark:text-white/40",
  },
};

/**
 * O desenho do estado vazio: o aparelho à esquerda, o Mac à direita, o cabo por baixo e o Wi-Fi por cima, com os
 * pontos andando devagar do aparelho para o Mac. Com `prefers-reduced-motion`, fica parado (ver `App.css`).
 */
function ConnectArt({ tone, compact }: { tone: Tone; compact: boolean }) {
  const { t } = useTranslation();
  const c = TEXT[tone];
  return (
    <div className="w-full">
      <svg viewBox="0 0 280 112" className={`block w-full ${compact ? "max-w-[240px]" : "max-w-[300px]"} mx-auto`} aria-hidden="true"
        fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {/* O aparelho */}
        <g className={`ade-connect-float ${c.art}`}>
          <rect x="22" y="14" width="42" height="80" rx="9" strokeWidth="2" />
          <rect x="37" y="19" width="12" height="3.5" rx="1.75" fill="currentColor" stroke="none" />
          <path d="M37 88h12" strokeWidth="1.6" />
        </g>
        {/* O Wi-Fi: as ondas saindo do aparelho e os pontos indo até o Mac */}
        <g className={c.flow} strokeWidth="2">
          <path className="ade-connect-wave" d="M72 38 a 8 8 0 0 1 0 12" />
          <path className="ade-connect-wave ade-connect-wave-2" d="M78 32 a 14 14 0 0 1 0 24" />
          <path className="ade-connect-wave ade-connect-wave-3" d="M84 26 a 20 20 0 0 1 0 36" />
          <path className="ade-connect-flow" d="M96 44 H 186" />
        </g>
        {/* O cabo: da base do aparelho à lateral do Mac */}
        <path className={`ade-connect-flow ${c.flow}`} strokeWidth="2" d="M43 98 C 43 108, 96 108, 132 100 S 180 84, 194 80" />
        <path className={c.art} strokeWidth="2" d="M43 94 v4" />
        {/* O Mac */}
        <g className={c.art} strokeWidth="2">
          <rect x="196" y="24" width="64" height="44" rx="4" />
          <path d="M186 76 h 84 l -6 6 h -72 z" />
        </g>
        <text x="141" y="36" textAnchor="middle" className={c.label} fill="currentColor" stroke="none" fontSize="10">{t("iphone.transport.wifi")}</text>
        <text x="132" y="94" textAnchor="middle" className={c.label} fill="currentColor" stroke="none" fontSize="10">{t("iphone.transport.usb")}</text>
      </svg>
      <div className={`mx-auto flex ${compact ? "max-w-[240px]" : "max-w-[300px]"} justify-between px-[4%] text-[10.5px] ${c.label}`}>
        <span>{t("iphone.empty.device")}</span>
        <span>{t("iphone.empty.thisMac")}</span>
      </div>
    </div>
  );
}

/**
 * Nenhum aparelho físico pronto: pede para ligar um iPhone ou iPad pelo cabo ou pelo Wi-Fi, desbloquear, tocar em
 * "Confiar" e ligar o Modo de Desenvolvedor. `compact` = dentro do seletor.
 */
export function ConnectHint({ tone, compact = false }: { tone: Tone; compact?: boolean }) {
  const { t } = useTranslation();
  const c = TEXT[tone];
  const steps = [t("iphone.empty.unlock"), t("iphone.empty.trust"), t("iphone.empty.devMode")];
  return (
    <div role="status" className={`flex flex-col items-center whitespace-normal text-center ${compact ? "gap-2 px-2 py-2" : "gap-3 px-4"}`}>
      <ConnectArt tone={tone} compact={compact} />
      <div className={`${compact ? "text-[12.5px]" : "text-[14px]"} font-semibold ${c.title}`}>{t("iphone.empty.title")}</div>
      <p className={`m-0 ${compact ? "text-[11.5px]" : "text-[12.5px]"} leading-snug ${c.body}`}>{t("iphone.empty.body")}</p>
      <ol className={`m-0 flex list-none flex-col gap-1 p-0 text-left ${compact ? "text-[11.5px]" : "text-[12px]"} leading-snug ${c.step}`}>
        {steps.map((step, i) => (
          <li key={step} className="flex gap-2">
            <span aria-hidden="true" className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ring-1 ring-current ${c.flow}`}>{i + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
