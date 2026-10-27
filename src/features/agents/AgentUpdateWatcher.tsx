import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { useTabsStore } from "@/features/tabs/store";
import { showBotToast, useBotToastStore } from "@/shared/brand/botToastStore";
import { getSetting } from "@/shared/ipc/settings";

import { ptyForTab, ptyKill } from "@/features/terminal/ipc";

import { exitAllWithSave } from "@/app/closeWithSave";

import { agentUpdate, agentUpdatesCheck, agentUpdateWorkRunning, detectAgents } from "./ipc";
import { updateAgentRestarting, type UpdateFlowOutcome } from "./updateFlow";
import { creep, STAGE_START, versionLine } from "./updateProgress";
import {
  AUTO_CHECK_INTERVAL_MS,
  FIRST_AGENT_CHECK_MS,
  AUTO_UPDATE_SETTING_KEY,
  isAutoUpdateEnabled,
  notifyKey,
  selectAutoUpdateTargets,
  selectToastTargets,
  type AgentUpdateInfo,
  type AgentUpdateResult,
} from "./updatePolicy";

export function reasonText(t: TFunction, code: string | null): string {
  if (!code) return "";
  return t(`agents.update.reason.${code}`, { defaultValue: t("agents.update.reason.failed") });
}

export function announceResult(t: TFunction, label: string, result: AgentUpdateResult) {
  if (result.ok) {
    showBotToast({
      title: label,
      text: result.newVersion
        ? t("agents.update.done", { label, version: result.newVersion })
        : t("agents.update.doneNoVersion", { label }),
    });
  } else {
    showBotToast({
      title: label,
      text: t("agents.update.failed", { label, error: reasonText(t, result.error) }),
      tone: "warning",
      ms: 10000,
    });
  }
}

/**
 * El "Actualizar" de un clic (botón o aviso del bot): cierra las terminales de ese agente, lo
 * actualiza y reinicia la app entera, que vuelve sola con las pestañas y las conversaciones
 * retomadas. Una misión o un run en curso lo impide (y entonces no se cierra nada).
 */
export async function runAgentUpdate(t: TFunction, info: AgentUpdateInfo): Promise<AgentUpdateResult> {
  const { setDetectedAgents } = useTabsStore.getState();
  const store = useBotToastStore.getState();
  // El globo de "Atualizando…" se queda hasta que termina, con la barra por etapas.
  const progressId = store.push({
    title: t("agents.update.progressTitle", { label: info.label }),
    text: versionLine(info.currentVersion, info.latestVersion) || t("agents.update.progressPreparing"),
    sticky: true,
    progress: 4,
  });
  const setProgress = (progress: number, text?: string) =>
    useBotToastStore.getState().update(progressId, text === undefined ? { progress } : { progress, text });
  let creeping: number | undefined;
  let current = 4;
  const stopCreeping = () => {
    if (creeping !== undefined) window.clearInterval(creeping);
    creeping = undefined;
  };
  // Lo que sea que tire el flujo vuelve como fallo: el globo de progreso nunca queda colgado.
  const outcome = await updateAgentRestarting(info.agentId, {
    tabs: () => useTabsStore.getState().tabs,
    ptyForTab,
    ptyKill,
    restartAgent: (tabId) => useTabsStore.getState().restartAgent(tabId),
    workRunning: agentUpdateWorkRunning,
    restartApp: () => exitAllWithSave("restart"),
    check: agentUpdatesCheck,
    update: agentUpdate,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStage: (stage, count) => {
      stopCreeping();
      current = STAGE_START[stage];
      if (stage === "closing") {
        setProgress(current, t("agents.update.closing", { label: info.label, count }));
      } else if (stage === "updating") {
        setProgress(current, versionLine(info.currentVersion, info.latestVersion) || t("agents.update.progressRunning"));
        creeping = window.setInterval(() => {
          current = creep(current);
          setProgress(current);
        }, 1000);
      } else if (stage === "restarting") {
        setProgress(current, t("agents.update.restarting", { label: info.label }));
      } else {
        setProgress(current);
      }
    },
  })
    .catch((error): UpdateFlowOutcome => ({
      result: { agentId: info.agentId, ok: false, output: String(error), newVersion: null, error: "failed" },
      reopened: 0,
      appRestarting: false,
    }))
    .finally(stopCreeping);
  // Con reinicio de la app el globo queda en 100% hasta que la app se cierra; si no, se retira.
  if (!outcome.appRestarting) useBotToastStore.getState().dismiss(progressId);
  if (!outcome.appRestarting) announceResult(t, info.label, outcome.result);
  if (outcome.reopened > 0) {
    showBotToast({ title: info.label, text: t("agents.update.reopened", { label: info.label, count: outcome.reopened }), ms: 7000 });
  }
  if (outcome.result.ok) detectAgents(true).then(setDetectedAgents).catch(() => {});
  return outcome.result;
}

/**
 * Revisa si hay versiones nuevas de las TUIs al abrir y cada 6 h. Con el modo automático
 * apagado (por defecto) solo avisa; prendido, actualiza de a uno los ociosos. Si el backend
 * rechaza (terminal abierta, misión en curso) la UI lo informa y no insiste.
 */
export function AgentUpdateWatcher() {
  const { t } = useTranslation();
  const setDetectedAgents = useTabsStore((s) => s.setDetectedAgents);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const notified = new Set<string>();

    const runUpdate = async (info: AgentUpdateInfo) => {
      const result = await agentUpdate(info.agentId);
      if (cancelled) return;
      announceResult(t, info.label, result);
      if (result.ok) detectAgents(true).then(setDetectedAgents).catch(() => {});
    };

    const check = async () => {
      if (running) return;
      running = true;
      try {
        const [infos, auto] = await Promise.all([
          agentUpdatesCheck(),
          getSetting(AUTO_UPDATE_SETTING_KEY).then(isAutoUpdateEnabled).catch(() => false),
        ]);
        if (cancelled) return;
        // Automático: actualiza solo los ociosos. Los que tienen una terminal abierta no se
        // tocan solos, pero reciben el mismo aviso con el botón (antes no pasaba nada).
        const handled = new Set<string>();
        if (auto) {
          for (const info of selectAutoUpdateTargets(infos)) {
            if (cancelled) return;
            handled.add(info.agentId);
            await runUpdate(info).catch(console.error);
          }
        }
        for (const info of selectToastTargets(infos.filter((i) => !handled.has(i.agentId)), notified)) {
          notified.add(notifyKey(info));
          showBotToast({
            title: info.label,
            text: t("agents.update.available", { label: info.label, version: versionLine(info.currentVersion, info.latestVersion) }),
            // sticky + versiones: el aviso se queda hasta que la persona decida (clic en Actualizar o ×)
            sticky: true,
            actionLabel: t("agents.update.action"),
            onAction: () => {
              runAgentUpdate(t, info).catch(console.error);
            },
            ms: 15000,
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        running = false;
      }
    };

    const first = setTimeout(check, FIRST_AGENT_CHECK_MS);
    const timer = setInterval(check, AUTO_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [t, setDetectedAgents]);

  return null;
}
