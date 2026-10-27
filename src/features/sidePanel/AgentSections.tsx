import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { tabConnectors, tabContextUsage, type Connector, type ContextUsage } from "@/features/tabs/panelIpc";
import type { Tab } from "@/features/tabs/types";

import { shortTokens } from "./panelModel";
import { Row, Section } from "./Section";

/** Só estes agentes têm transcript e config que a ADE sabe ler (ver `session/panel.rs`). */
const READABLE = new Set(["claude-code", "codex"]);

/** O contexto muda a cada resposta do agente: relê enquanto a aba está aberta. */
const CONTEXT_POLL_MS = 15_000;

function useContext(tab: Tab) {
  const [usage, setUsage] = useState<ContextUsage | null | undefined>(undefined);
  useEffect(() => {
    setUsage(undefined);
    if (!READABLE.has(tab.agentId) || !tab.sessionId) return;
    let alive = true;
    const load = () => tabContextUsage(tab.agentId, tab.cwd, tab.sessionId!, tab.accountId ?? null)
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(null));
    load();
    const timer = window.setInterval(load, CONTEXT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab.agentId, tab.cwd, tab.sessionId, tab.accountId]);
  return usage;
}

const tone = (pct: number) => (pct >= 85 ? "bg-rose-500" : pct >= 60 ? "bg-amber-500" : "bg-accent-500");

/** Quanto da janela de contexto a conversa do agente já ocupa, como o "Contexto 11%" do Claude Code. */
export function ContextSection({ tab }: { tab: Tab }) {
  const { t, i18n } = useTranslation();
  const usage = useContext(tab);
  const pct = usage ? Math.min(100, Math.max(0, usage.percent)) : null;

  return (
    <Section id="context" title={t("sidePanel.context.title")} defaultOpen={false}
      aside={pct !== null && (
        <span className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/45 tabular-nums">
          {Math.round(pct)}%
          <span className="relative w-6 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
            <span className={`absolute inset-y-0 left-0 ${tone(pct)}`} style={{ width: `${pct}%` }} />
          </span>
        </span>
      )}>
      {!READABLE.has(tab.agentId) ? (
        <Row>{t("sidePanel.context.unsupported")}</Row>
      ) : usage ? (
        <>
          <Row>{t("sidePanel.context.used", { used: shortTokens(usage.usedTokens, i18n.language), window: shortTokens(usage.windowTokens, i18n.language) })}</Row>
          {usage.model && <Row><span className="text-gray-500 dark:text-white/45">{t("sidePanel.context.model", { model: usage.model })}</span></Row>}
        </>
      ) : (
        <Row><span className="text-gray-500 dark:text-white/45">{t("sidePanel.context.unavailable")}</span></Row>
      )}
    </Section>
  );
}

/** Os MCPs configurados para o agente nesta pasta (configuração, não estado ao vivo). */
export function ConnectorsSection({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const [list, setList] = useState<Connector[] | null>(null);
  useEffect(() => {
    setList(null);
    if (!READABLE.has(tab.agentId)) { setList([]); return; }
    let alive = true;
    tabConnectors(tab.agentId, tab.cwd, tab.accountId ?? null, tab.id)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => { alive = false; };
  }, [tab.agentId, tab.cwd, tab.accountId, tab.id]);

  return (
    <Section id="connectors" title={t("sidePanel.connectors.title")} defaultOpen={false}
      aside={list && list.length > 0
        ? <span className="text-[11px] text-gray-500 dark:text-white/45 tabular-nums">{list.length}</span>
        : undefined}>
      {list?.length === 0 && <Row><span className="text-gray-500 dark:text-white/45">{t("sidePanel.connectors.none")}</span></Row>}
      {list?.map((c) => (
        <Row key={`${c.scope}:${c.name}`} title={c.detail ?? undefined}
          icon={<span className={`block w-1.5 h-1.5 rounded-full ${c.scope === "ade" ? "bg-accent-500" : "bg-emerald-500"}`} />}
          trailing={<span className="shrink-0 text-[10.5px] text-gray-400 dark:text-white/35">{t(`sidePanel.connectors.scope.${c.scope}`)} · {c.transport}</span>}>
          {c.name}
        </Row>
      ))}
    </Section>
  );
}
