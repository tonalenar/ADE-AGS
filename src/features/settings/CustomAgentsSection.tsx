import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, EditIcon, Tooltip, TrashIcon } from "neogestify-ui-components";

import { AlertaToast } from "@/shared/ui/alerts";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { CustomAgentForm } from "@/features/agents/CustomAgentForm";

/** Chips de "qué integración tiene configurada esta TUI", para no tener que abrir el
 *  formulario solo para saber si reanuda sesiones o si le gestionamos skills. */
function AgentCapabilities({ agent }: { agent: CustomAgent }) {
  const { t } = useTranslation();
  const caps = [
    agent.resumeArgs && t("settings.tuis.cap.resume"),
    agent.skillsDir && t("settings.tuis.cap.skills"),
    agent.sessionsDir && t("settings.tuis.cap.sessions"),
    Object.keys(agent.env ?? {}).length > 0 && t("settings.tuis.cap.env"),
  ].filter(Boolean) as string[];

  if (caps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {caps.map((c) => (
        <span key={c} className="inline-flex h-4 items-center rounded-full px-1.5
          text-[10px] font-medium
          bg-accent-500/12 text-accent-600 dark:bg-accent-400/15 dark:text-accent-300">
          {c}
        </span>
      ))}
    </div>
  );
}

/**
 * As TUIs que a pessoa adicionou à mão (Provedores › TUIs). Editar abre o formulário no lugar da
 * linha; excluir pede um segundo clique em 3 s, e mostra o erro se o backend recusar.
 */
export function CustomAgentsSection() {
  const { t } = useTranslation();
  const customAgents = useAgentsStore((s) => s.customAgents);
  const saveCustomAgent = useAgentsStore((s) => s.saveCustomAgent);
  const removeCustomAgent = useAgentsStore((s) => s.removeCustomAgent);
  const [armedAgent, setArmedAgent] = useState<string | null>(null);
  /** Id da TUI que se está editando em línea; `null` = solo el formulario de alta. */
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!armedAgent) return;
    const timer = window.setTimeout(() => setArmedAgent(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armedAgent]);

  const deleteCustomAgent = (id: string) => {
    if (armedAgent !== id) { setArmedAgent(id); return; }
    setArmedAgent(null);
    removeCustomAgent(id).catch((e) => AlertaToast(t("btn.delete"), String(e), "error", 6000));
  };

  return (
    <>
      <span className="mt-2 text-[11px] leading-[14px] font-semibold uppercase tracking-[0.06em]
        text-gray-500 dark:text-white/45">
        {t("settings.tuis.custom")}
      </span>
      {customAgents.length === 0 ? (
        <p className="text-[12px] leading-4 text-gray-500 dark:text-white/40">
          {t("settings.tuis.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {customAgents.map((agent) => (
            editingId === agent.id ? (
              <CustomAgentForm
                key={agent.id}
                initial={agent}
                onSubmit={async (draft) => {
                  await saveCustomAgent(draft);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div
                key={agent.id}
                className="cc-t flex items-center gap-3 px-3 py-2.5 rounded-xl
                  bg-gray-100/70 dark:bg-surface-raised/60
                  hover:bg-gray-200/60 dark:hover:bg-surface-raised"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0
                  shadow-[0_0_0_3px_rgba(48,209,88,0.18)]" />
                <div className="flex flex-col gap-px min-w-0 flex-1">
                  <span title={agent.label} className="truncate text-[13px] font-semibold
                    text-gray-900 dark:text-gray-100">
                    {agent.label}
                  </span>
                  <span title={agent.command} className="truncate font-mono text-[11px] tabular-nums
                    text-gray-500 dark:text-white/40">
                    {agent.command}
                  </span>
                  <AgentCapabilities agent={agent} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Tooltip content={t("btn.edit")} placement="left">
                    <Button variant="icon"
                      onClick={() => setEditingId(agent.id)}
                      aria-label={t("btn.edit")}
                      className="cc-t flex items-center justify-center w-7 h-7 rounded-md
                        text-gray-500 dark:text-white/40
                        hover:text-gray-900 dark:hover:text-white
                        hover:bg-gray-200 dark:hover:bg-white/10 p-0"
                    >
                      <EditIcon className="w-3.5 h-3.5" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t("btn.delete")} placement="left">
                    <Button variant="icon"
                      onClick={() => deleteCustomAgent(agent.id)}
                      aria-label={t("btn.delete")}
                      className="cc-t flex items-center justify-center w-7 h-7 rounded-md
                        text-gray-500 dark:text-white/40
                        hover:text-red-500 dark:hover:text-red-400
                        hover:bg-gray-200 dark:hover:bg-white/10 p-0"
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </Button>
                  </Tooltip>
                </div>
              </div>
            )
          ))}
        </div>
      )}

      <CustomAgentForm onSubmit={saveCustomAgent} />
    </>
  );
}
