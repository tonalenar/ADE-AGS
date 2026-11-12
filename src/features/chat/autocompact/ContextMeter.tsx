import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { autoCompactEnabledFor, compactTokens, effectivePct, meterTone, type ContextUsage, type MeterTone } from "./model";
import { chatPlanOf, useAutoCompact } from "./store";

const TONE: Record<MeterTone, string> = {
  ok: "stroke-gray-400 dark:stroke-white/40",
  near: "stroke-amber-500",
  over: "stroke-red-500",
};

/**
 * O medidor de contexto do composer: um anel com a fração da janela ocupada e uma marca no limiar em que a ADE
 * compacta. O tooltip diz os tokens, a janela e o estado do autocompact do agente (liga, desliga ou «o agente compacta
 * sozinho»). Sem medida (agente sem janela informada), não desenha nada.
 */
export function ContextMeter({ usage, agentId }: { usage: ContextUsage | null; agentId: string }) {
  const { t } = useTranslation();
  const config = useAutoCompact((s) => s.config);
  const plans = useAutoCompact((s) => s.plans);
  const load = useAutoCompact((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  if (!usage) return null;
  const plan = chatPlanOf(plans, agentId);
  const supported = plan?.supported ?? false;
  const nativeAuto = plan?.mechanism === "nativeAuto";
  const enabled = supported && autoCompactEnabledFor(config, agentId);
  const threshold = effectivePct(config, agentId);
  const tone = meterTone(usage.pct, threshold);
  const pct = Math.round(usage.pct);
  const state = !supported ? t("chat.contextMeter.unsupported")
    : !enabled ? t("chat.contextMeter.off")
      : nativeAuto ? t("chat.contextMeter.native", { pct: threshold })
        : t("chat.contextMeter.on", { pct: threshold });
  const title = t("chat.contextMeter.tooltip", { used: compactTokens(usage.used), window: compactTokens(usage.window), pct, state })
    + (usage.windowKnown ? "" : ` ${t("chat.contextMeter.estimated")}`);
  const circumference = 2 * Math.PI * 7;
  // A marca do limiar, no mesmo referencial do traço (o SVG gira -90° para o traço começar no topo).
  const angle = (threshold / 100) * 2 * Math.PI;
  const tick = (radius: number) => ({ x: 9 + radius * Math.cos(angle), y: 9 + radius * Math.sin(angle) });
  const inner = tick(5);
  const outer = tick(9);
  return (
    <span role="img" aria-label={title} title={title} data-context-meter={tone}
      className="flex shrink-0 items-center gap-1 px-1 text-chat-caption tabular-nums text-gray-500 dark:text-white/50">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="-rotate-90">
        <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" className="stroke-gray-200 dark:stroke-white/15" />
        <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={`${(usage.pct / 100) * circumference} ${circumference}`} className={TONE[tone]} />
        {enabled && <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} strokeWidth="1.5" className="stroke-gray-600 dark:stroke-white/70" />}
      </svg>
      <span>{pct}%</span>
    </span>
  );
}
