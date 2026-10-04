import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { useTabsStore } from "@/features/tabs/store";
import { showBotToast } from "@/shared/brand/botToastStore";
import { getSetting } from "@/shared/ipc/settings";

import { agentUpdate, agentUpdatesCheck, detectAgents } from "./ipc";
import {
  AUTO_CHECK_INTERVAL_MS,
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
        if (auto) {
          for (const info of selectAutoUpdateTargets(infos)) {
            if (cancelled) return;
            await runUpdate(info).catch(console.error);
          }
          return;
        }
        for (const info of selectToastTargets(infos, notified)) {
          notified.add(notifyKey(info));
          showBotToast({
            title: info.label,
            text: t("agents.update.available", { label: info.label, version: info.latestVersion }),
            actionLabel: t("agents.update.action"),
            onAction: () => {
              agentUpdate(info.agentId)
                .then((r) => {
                  announceResult(t, info.label, r);
                  if (r.ok) detectAgents(true).then(setDetectedAgents).catch(() => {});
                })
                .catch(console.error);
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

    check();
    const timer = setInterval(check, AUTO_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [t, setDetectedAgents]);

  return null;
}
