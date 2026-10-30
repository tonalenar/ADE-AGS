import { useState } from "react";
import { useTranslation } from "react-i18next";

import { activityPhrase, formatElapsed, formatTokens, planProgress, type Activity, type TurnLive } from "./activityModel";
import { useNow, type LiveSummary } from "./liveSummary";
import type { PlanStep, ToolStatus } from "./timeline/types";

/**
 * As peças do "agente trabalhando" (prancheta 13): os três pontos, a linha viva acima do composer
 * com "Ver o que está fazendo", o plano do turno e o estado curto do cabeçalho e da sidebar.
 */

/** Os três pontos de 5 px com pulso de 1,2 s (parados com `prefers-reduced-motion`; ver `App.css`). */
export function Dots({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex gap-[3px] shrink-0 text-orange-700 dark:text-orange-400 ${className}`}>
      <span className="cc-dot" /><span className="cc-dot" /><span className="cc-dot" />
    </span>
  );
}

/** A frase da atividade ("Rodando testes", "Editando frameBridge.ts", "Pensando…"). */
export function useActivityText(activity: Activity): string {
  const { t } = useTranslation();
  const { key, target } = activityPhrase(activity);
  return t(key, { target });
}

const MARK: Record<ToolStatus, string> = { running: "…", done: "✓", error: "✗", denied: "⊘" };

/**
 * A linha viva acima do composer: os pontos, a atividade, o tempo e os tokens do turno e o botão que
 * abre os últimos comandos e o raciocínio mais recente.
 */
export function ActivityLine({ live, startedAt }: { live: TurnLive; startedAt: number | null }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const now = useNow(true);
  const text = useActivityText(live.activity);
  const since = live.startedAt ?? startedAt;
  const meta = [
    since !== null ? formatElapsed(now - since) : null,
    live.tokens !== null && live.tokens > 0 ? t("chat.live.tokens", { count: formatTokens(live.tokens, i18n.language) }) : null,
  ].filter(Boolean).join(" · ");
  const hasDetails = live.recent.length > 0 || !!live.reasoning;
  return (
    <>
      <div role="status" aria-live="polite" className="flex items-center gap-2.5 px-1.5 pt-2 pb-2.5 text-chat-ui text-gray-600 dark:text-white/60">
        <Dots />
        <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">{text}</span>
        {/* O tempo muda a cada segundo: fora do anúncio, para o leitor de tela não repetir a linha. */}
        {meta && <span aria-hidden="true" className="shrink-0 whitespace-nowrap text-gray-500 dark:text-white/45">{meta}</span>}
        <span className="flex-1" />
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="shrink-0 h-6 px-2 rounded-md text-chat-caption text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white">
          {open ? t("chat.live.hide") : t("chat.live.show")}
        </button>
      </div>
      {open && (
        <div className="mb-2.5 px-3 py-2.5 rounded-[10px] bg-gray-100 dark:bg-white/[0.06] font-mono text-chat-code leading-[1.6] text-gray-600 dark:text-white/60 break-words">
          {!hasDetails && <div>{t("chat.live.nothingYet")}</div>}
          {live.recent.map((r) => (
            <div key={r.id}>› {r.label} {MARK[r.status]}</div>
          ))}
          {live.reasoning && <div>{t("chat.live.reasoning", { text: tail(live.reasoning, 240) })}</div>}
        </div>
      )}
    </>
  );
}

/** O fim de um texto longo numa linha (o raciocínio mais recente). */
function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/\*\*/g, "").trim();
  return flat.length > max ? `…${flat.slice(flat.length - max + 1)}` : flat;
}

/** O plano do turno: "Plano · 2 de 4", o passo atual em destaque e os concluídos riscados. */
export function PlanCard({ plan }: { plan: PlanStep[] }) {
  const { t } = useTranslation();
  const { done, total, current } = planProgress(plan);
  return (
    <section aria-label={t("chat.plan.label")} className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-sunken px-3.5 py-2.5">
      <div className="mb-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/45">{t("chat.plan.progress", { done, total })}</div>
      <ol className="m-0 p-0 list-none">
        {plan.map((step, i) => {
          const state = step.status === "completed" ? "done" : i === current ? "now" : "todo";
          return (
            <li key={`${i}-${step.text}`} aria-current={state === "now" ? "step" : undefined}
              className={`flex items-center gap-2.5 h-[26px] ${state === "todo" ? "text-gray-500 dark:text-white/45" : "text-gray-900 dark:text-white"}`}>
              <span aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 rounded-full box-border
                ${state === "done" ? "bg-emerald-700 dark:bg-emerald-400" : state === "now" ? "border-2 border-orange-700 dark:border-orange-400" : "border-[1.5px] border-gray-400 dark:border-white/35"}`} />
              <span className={`truncate ${state === "done" ? "line-through text-gray-500 dark:text-white/45" : state === "now" ? "font-medium" : ""}`}>
                {step.text}
              </span>
              {state === "done" && <span className="sr-only">{t("chat.plan.doneStep")}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** "Trabalhando · 52 s" no cabeçalho da conversa aberta. */
export function HeaderLive({ live }: { live: LiveSummary }) {
  const { t } = useTranslation();
  const now = useNow(live.working);
  if (!live.working) return null;
  return (
    <span className="shrink-0 inline-flex items-center gap-1.5 text-chat-caption text-orange-700 dark:text-orange-400">
      <Dots />
      {live.waiting ? t("chat.live.waitingShort") : t("chat.status.working")}
      {live.startedAt !== null && <span aria-hidden="true">· {formatElapsed(now - live.startedAt)}</span>}
    </span>
  );
}

/** A linha viva de um cartão da sidebar: "Rodando testes · 1 min 12 s". */
export function SidebarLiveRow({ live }: { live: LiveSummary }) {
  const now = useNow(live.working);
  const text = useActivityText(live.activity);
  return (
    <span className="flex items-center gap-1.5 min-w-0 text-chat-caption text-orange-700 dark:text-orange-400">
      <Dots />
      <span className="truncate">{text}{live.startedAt !== null ? ` · ${formatElapsed(now - live.startedAt)}` : ""}</span>
    </span>
  );
}
