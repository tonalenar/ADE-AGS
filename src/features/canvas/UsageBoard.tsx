import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { accountEnv, codexAccountUsage } from "@/features/accounts/ipc";
import { accountProblemKey } from "@/features/accounts/problem";
import type { AgentAccount, CodexUsage, QuotaWindow } from "@/features/accounts/types";
import { agentAccountUsage, claudeLiveUsage, isUsageFresh, planLabel, type LiveUsage } from "@/features/accounts/usage";

import { RING_COLORS, Ring } from "./Ring";

// ── Piezas ──────────────────────────────────────────────────────────

const TICKS = 32;

/**
 * Una barra de tramos, como el medidor de un panel de control: cuanto más llena, más
 * encendida. El color sube de tono con el uso (verde → ámbar → rojo) en vez de ser el mismo
 * siempre: un 90 % tiene que verse distinto de un 10 % sin leer el número.
 */
export function SegmentBar({ percent, color }: { percent: number; color: string }) {
  const lit = Math.round((Math.max(0, Math.min(100, percent)) / 100) * TICKS);
  const tone = percent >= 90 ? "#ef4444" : percent >= 70 ? "#f59e0b" : color;
  return (
    <div className="flex items-center gap-[2px] h-4" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: TICKS }, (_, i) => (
        <span key={i} className="flex-1 h-full rounded-[1.5px] transition-colors duration-500"
          style={{ background: i < lit ? tone : "currentColor", opacity: i < lit ? 1 : 0.12 }} />
      ))}
    </div>
  );
}

/** Un límite: su nombre, el porcentaje, la barra y cuándo se reinicia. */
export function Meter({ label, percent, resets, color }: { label: string; percent: number; resets?: string | null; color: string }) {
  return (
    <div className="text-gray-500 dark:text-gray-400">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[12px] font-medium text-gray-800 dark:text-gray-100">{label}</span>
        <span className="text-[12px] font-semibold tabular-nums text-gray-800 dark:text-gray-100">{percent}%</span>
      </div>
      <SegmentBar percent={percent} color={color} />
      {resets && <div className="mt-1 text-[10.5px] text-gray-400 dark:text-gray-500">{resets}</div>}
    </div>
  );
}

/** Lo que falta para un instante, en palabras: "en 1 h 20 min", "en 6 días". */
export function untilText(at: number | null, now: number, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (!at) return null;
  const secs = at - now;
  if (secs <= 0) return t("canvas.usage.resetsNow");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("canvas.usage.resetsIn", { value: `${Math.max(1, mins)} min` });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t("canvas.usage.resetsIn", { value: mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h` });
  return t("canvas.usage.resetsIn", { value: t("canvas.usage.days", { count: Math.round(hours / 24) }) });
}

/** El encabezado de cada agente: icono, nombre, cuenta y un anillo grande con el uso. */
function Head({ account, plan, percent, color, children }: {
  account: AgentAccount; plan: string | null; percent: number | null; color: string; children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const Icon = agentIcon(account.agentId, account.agentId);
  const name = t(`canvas.usage.agent.${account.agentId}`, { defaultValue: account.agentId });
  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0 flex items-center justify-center w-[52px] h-[52px] text-gray-300 dark:text-white">
        <Ring percent={percent} color={color} size={52} stroke={4} />
        <Icon className="absolute w-5 h-5 text-gray-600 dark:text-gray-300" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-gray-900 dark:text-white">{name}</span>
          {plan && (
            <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-semibold uppercase tracking-wide
              bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">{plan}</span>
          )}
        </div>
        <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">{account.label ?? account.name}</div>
      </div>
      {children}
    </div>
  );
}

const Skeleton = () => (
  <div className="space-y-3 animate-pulse">
    {[0, 1].map((i) => (
      <div key={i}>
        <div className="flex justify-between mb-1"><span className="h-3 w-20 rounded bg-gray-200 dark:bg-white/10" /><span className="h-3 w-8 rounded bg-gray-200 dark:bg-white/10" /></div>
        <div className="h-4 rounded bg-gray-100 dark:bg-white/6" />
      </div>
    ))}
  </div>
);

function Notice({ tone = "neutral", children, action }: { tone?: "neutral" | "warn"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 text-[11.5px] leading-snug
      ${tone === "warn"
        ? "bg-amber-500/10 text-amber-800 dark:text-amber-200 border border-amber-500/25"
        : "bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-white/10"}`}>
      <span className="flex-1">{children}</span>
      {action}
    </div>
  );
}

const RefreshButton = ({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) => (
  <Button variant="custom" onClick={onClick} disabled={busy} aria-label={label} title={label}
    className="cc-t shrink-0 h-7 px-2.5 rounded-full text-[11px] font-medium border border-gray-200 dark:border-white/12
      text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-50">
    {busy ? "…" : label}
  </Button>
);

// ── Claude Code ─────────────────────────────────────────────────────

/**
 * El cupo de Claude Code: la sesión de cinco horas, la semana y la semana por modelo. Sale
 * de preguntarle `/usage` a la propia TUI (ver `usage/live.rs`), que arranca una terminal
 * entera: por eso se muestra enseguida lo último que se supo y se actualiza detrás.
 */
function ClaudeSection({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  const [live, setLive] = useState<LiveUsage | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async (force: boolean) => {
    setBusy(true);
    try {
      const env = account.id.startsWith("system:") ? {} : await accountEnv(account.id);
      setLive(await claudeLiveUsage(account.id, env, force));
    } catch (e) {
      setLive({ available: false, session: null, week: null, weekModels: [], fetchedAt: 0, cached: false, problem: String(e) });
    } finally {
      setBusy(false);
    }
  }, [account.id]);

  useEffect(() => {
    let stale = false;
    agentAccountUsage(account.agentId, account.id.startsWith("system:") ? null : account.id)
      .then((u) => !stale && setPlan(planLabel(u.plan.tier)))
      .catch(() => undefined);
    // Primero lo guardado, al instante; después, si venció, se pregunta de verdad.
    (async () => {
      await ask(false);
    })();
    return () => { stale = true; };
  }, [account.id, account.agentId, ask]);

  // Si lo que apareció está viejo, se refresca solo una vez, sin que nadie lo pida.
  useEffect(() => {
    if (live && live.available && !live.cached) return;
    if (live && live.available && live.cached && !isUsageFresh(live.fetchedAt, Math.floor(Date.now() / 1000))) void ask(true);
    // Solo cuando llega el primer dato guardado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live === null]);

  const now = Math.floor(Date.now() / 1000);
  const color = RING_COLORS.claude;
  const problemKey = live && !live.available ? accountProblemKey(live.problem) : null;

  return (
    <section className="px-4 py-4 space-y-3.5">
      <Head account={account} plan={plan} percent={live?.available ? live.session?.percent ?? null : null} color={color}>
        <RefreshButton busy={busy} onClick={() => void ask(true)} label={t("canvas.usage.refresh")} />
      </Head>

      {live === null ? <Skeleton /> : live.available ? (
        <>
          {live.session && <Meter label={t("canvas.usage.session")} percent={live.session.percent} resets={live.session.resets ? t("canvas.usage.resetsAt", { when: live.session.resets }) : null} color={color} />}
          {live.week && <Meter label={t("canvas.usage.week")} percent={live.week.percent} resets={live.week.resets ? t("canvas.usage.resetsAt", { when: live.week.resets }) : null} color={color} />}
          {live.weekModels.map((m) => (
            <Meter key={m.model} label={`${m.model} · ${t("canvas.usage.week")}`} percent={m.meter.percent} resets={m.meter.resets ? t("canvas.usage.resetsAt", { when: m.meter.resets }) : null} color={color} />
          ))}
          {live.fetchedAt > 0 && (
            <div className="text-[10px] text-gray-400 dark:text-gray-500">
              {t("canvas.usage.updated", { ago: ago(now - live.fetchedAt, t) })}{live.cached ? ` · ${t("canvas.usage.cached")}` : ""}
            </div>
          )}
        </>
      ) : (
        <Notice tone="warn" action={<RefreshButton busy={busy} onClick={() => void ask(true)} label={t("canvas.usage.retry")} />}>
          {problemKey ? t(problemKey) : t("canvas.usage.failed")}
        </Notice>
      )}
    </section>
  );
}

function ago(seconds: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (seconds < 45) return t("canvas.usage.now");
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
}

// ── Codex ───────────────────────────────────────────────────────────

/** El cupo de Codex: sus dos ventanas, de cinco horas y de siete días. Barato de preguntar. */
function CodexSection({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<CodexUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      setUsage(await codexAccountUsage(account.id));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [account.id]);
  useEffect(() => { void load(); }, [load]);

  const now = Math.floor(Date.now() / 1000);
  const color = RING_COLORS.codex;
  const meter = (label: string, w: QuotaWindow | null) =>
    w ? <Meter label={label} percent={Math.round(w.utilization * 100)} resets={untilText(w.resetsAt, now, t)} color={color} /> : null;
  const five = usage?.quota?.fiveHour ?? null;

  return (
    <section className="px-4 py-4 space-y-3.5">
      <Head account={account} plan={usage?.plan ?? null} percent={five ? Math.round(five.utilization * 100) : null} color={color}>
        <RefreshButton busy={busy} onClick={() => void load()} label={t("canvas.usage.refresh")} />
      </Head>
      {failed ? (
        <Notice tone="warn" action={<RefreshButton busy={busy} onClick={() => void load()} label={t("canvas.usage.retry")} />}>{t("canvas.usage.failed")}</Notice>
      ) : !usage ? <Skeleton /> : usage.auth === "apiKey" ? (
        <Notice>{t("canvas.usage.apiKey")}</Notice>
      ) : (
        <>
          {meter(t("canvas.usage.session"), usage.quota?.fiveHour ?? null)}
          {meter(t("canvas.usage.week"), usage.quota?.sevenDay ?? null)}
          {!usage.quota?.fiveHour && !usage.quota?.sevenDay && <Notice>{t("canvas.usage.noWindows")}</Notice>}
          {usage.quota?.rejected && <Notice tone="warn">{t("canvas.usage.rejected")}</Notice>}
        </>
      )}
    </section>
  );
}

// ── El resto ────────────────────────────────────────────────────────

/** Los agentes que no miden un cupo por ventana: se dice, en vez de mostrar una barra falsa. */
function OtherSection({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  return (
    <section className="px-4 py-4 space-y-3">
      <Head account={account} plan={null} percent={null} color="#94a3b8" />
      <Notice>{t("canvas.usage.noLimits")}</Notice>
    </section>
  );
}

/**
 * Todas las cuentas con sesión, una debajo de otra. Cada Claude arranca su terminal para
 * preguntar el cupo, así que se piden de a una (ver `Stagger`): abrirlas todas juntas
 * lanzaría varias TUIs al mismo tiempo.
 */
export function UsageBoard({ accounts }: { accounts: AgentAccount[] }) {
  const { t } = useTranslation();
  if (accounts.length === 0) return <p className="p-5 text-[12px] text-gray-500 dark:text-gray-400">{t("canvas.dock.noAccounts")}</p>;
  return (
    <div className="divide-y divide-gray-100 dark:divide-white/6">
      {accounts.map((a, i) => (
        <Stagger key={a.id} index={a.agentId === "claude-code" ? accounts.slice(0, i).filter((x) => x.agentId === "claude-code").length : 0}>
          {a.agentId === "claude-code" ? <ClaudeSection account={a} /> : a.agentId === "codex" ? <CodexSection account={a} /> : <OtherSection account={a} />}
        </Stagger>
      ))}
    </div>
  );
}

/** Monta a sus hijos después de `index` × 6 s: la segunda cuenta de Claude espera a que la primera termine. */
function Stagger({ index, children }: { index: number; children: React.ReactNode }) {
  const [ready, setReady] = useState(index === 0);
  useEffect(() => {
    if (index === 0) return;
    const timer = window.setTimeout(() => setReady(true), index * 6000);
    return () => window.clearTimeout(timer);
  }, [index]);
  return ready ? <>{children}</> : <div className="px-4 py-4 text-[11px] text-gray-400 animate-pulse">…</div>;
}
