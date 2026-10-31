import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { useTerminalPrompts } from "@/features/canvas/useTerminalPrompts";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

import { ASK_TITLE } from "./PermissionCard";
import { chatRequestsSweep } from "../structured/ipc";
import { hydrateThread, useStructured } from "../structured/store";
import { autoAllowRule, decidedByBackend, freshAsks } from "./permissionModel";
import { startTeams } from "../team/teamStore";
import { answerAsk, loadRules, notifyAsk, setTuiPrompts, teamDecision, toggleInbox, usePendingAsks, usePermissions } from "./permissionsStore";

/**
 * O que a caixa de permissões precisa rodando enquanto a casca do chat está aberta, sem desenhar
 * nada: lê os diálogos das TUIs de todos os agentes da janela, aplica as regras "Sempre permitir"
 * aos pedidos novos (nunca os de risco alto), avisa o sistema quando chega pedido com o app em
 * segundo plano e liga o atalho ⇧⌘A (Ctrl+Shift+A fora do macOS).
 */
export function PermissionsManager() {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const agentTabs = useMemo(() => tabs.filter((tab) => tab.agentId !== SHELL_AGENT_ID).map((tab) => ({ id: tab.id, name: tab.title })), [tabs]);
  const prompts = useTerminalPrompts(agentTabs, true);
  useEffect(() => setTuiPrompts(prompts), [prompts]);
  useEffect(() => { void loadRules(); }, []);
  // A política do time de cada integrante decide antes das regras (ver `teamDecision`).
  useEffect(() => startTeams(), []);

  // Os pedidos das conversas por protocolo são decididos no backend. Aqui a janela só os MOSTRA: lê os pendentes de
  // TODAS as conversas ativas (antes só a aberta era lida, e um pedido de um integrante em segundo plano nunca
  // aparecia) e pede ao backend que reaplique a política e as regras ao que sobrou (depois de um reload).
  const threads = useStructured((s) => s.threads);
  const activeIds = useMemo(() => threads.filter((th) => th.state === "active").map((th) => th.id).join(","), [threads]);
  useEffect(() => {
    for (const id of activeIds ? activeIds.split(",") : []) hydrateThread(id);
  }, [activeIds]);
  useEffect(() => { chatRequestsSweep().catch(() => undefined); }, []);

  const asks = usePendingAsks();
  const rules = usePermissions((s) => s.rules);
  const loaded = usePermissions((s) => s.rulesLoaded);
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Sem as regras lidas, um pedido novo ainda não pode ser decidido: espera.
    if (!loaded) return;
    const fresh = freshAsks(seen.current, asks);
    seen.current = new Set(asks.map((a) => a.id));
    for (const ask of fresh) {
      // O backend já decidiu o que a política e as regras cobrem; o que chegou aqui é da pessoa.
      if (decidedByBackend(ask)) {
        if (!document.hasFocus()) notifyAsk(t(ASK_TITLE[ask.kind], { agent: ask.agentLabel }), ask.detail || ask.where);
        continue;
      }
      // Integrante de um time: a política dele vem primeiro. Só leitura nega mesmo com regra; o que ela
      // deixa passa sem perguntar; o resto (e todo risco alto) segue para as regras e para a pessoa.
      const team = teamDecision(ask);
      if (team === "deny") {
        answerAsk(ask, "deny", t("chat.team.permission.denied"));
        continue;
      }
      if (team === "allow") {
        answerAsk(ask, "allow");
        continue;
      }
      if (autoAllowRule(rules, ask)) {
        answerAsk(ask, "allow");
        continue;
      }
      // A frota já avisa pelo notificador dela (`approvals.changed`).
      if (ask.ref.source !== "fleet" && !document.hasFocus()) {
        notifyAsk(t(ASK_TITLE[ask.kind], { agent: ask.agentLabel }), ask.detail || ask.where);
      }
    }
  }, [asks, rules, loaded, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || !e.shiftKey || e.altKey) return;
      const chord = DESKTOP_OS === "macos" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!chord) return;
      // Na fase de captura, antes do terminal: o acorde não chega à TUI.
      e.preventDefault();
      e.stopPropagation();
      toggleInbox();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return null;
}
