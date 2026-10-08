import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import type { AgentInfo } from "@/features/tabs/types";

interface AgentPickerStepProps {
  agents: AgentInfo[];
  selected: string | null;
  onSelect: (agent: AgentInfo) => void;
}

/**
 * Con qué TUI abrir la tab.
 *
 * Las tarjetas son las de Home, literalmente: esta lista tenía una piel propia —un borde
 * de color distinto por agente, y blancos fijos que solo se veían bien en modo oscuro—
 * mientras que Home dibujaba la MISMA decisión con el lenguaje del resto de la app. Eran
 * dos pantallas para elegir lo mismo que no se parecían en nada, así que quedó una y Home
 * la usa.
 *
 * El logo de la TUI es el mismo que después identifica la tab en la barra: la elección de
 * acá y lo que se ve arriba después tienen que poder reconocerse entre sí.
 */
export function AgentPickerStep({ agents, selected, onSelect }: AgentPickerStepProps) {
  const { t } = useTranslation();
  const available = agents.filter((a) => a.available);

  if (available.length === 0) {
    return (
      <p className="text-xs italic text-gray-400 dark:text-white/30">
        {t("wizard.step2.detecting")}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {available.map((agent) => {
        const isSelected = agent.id === selected;
        const AgentIcon = agentIcon(agent.id, agent.command);
        return (
          <Button variant="custom"
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent)}
            aria-pressed={isSelected}
            className={`
              group relative flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left
              transition-colors duration-200
              ${isSelected
                ? "border-accent-500 bg-accent-50 dark:bg-accent-500/10 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_20%,transparent)]"
                : "border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-surface-raised/60 hover:border-black/15 dark:hover:border-white/15"}
            `}
          >
            <span className="shrink-0 flex items-center justify-center w-9 h-9 rounded-[9px] text-white shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)]"
              style={{ background: agentTile(agent.id) }}>
              <AgentIcon className="w-5 h-5" />
            </span>
            {isSelected && (
              <span aria-hidden className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-accent-500 text-white">
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 6.2 2.3 2.3 4.7-4.9" /></svg>
              </span>
            )}

            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className={`truncate text-[12.5px] font-semibold transition-colors
                  ${isSelected
                    ? "text-accent-700 dark:text-accent-300"
                    : "text-gray-800 dark:text-gray-100 group-hover:text-gray-900 dark:group-hover:text-white"}`}>
                  {agent.label}
                </span>
                {agent.isCustom && (
                  <span className="shrink-0 px-1 rounded text-[9.5px]
                    bg-violet-500/12 text-violet-600 dark:text-violet-400">
                    {t("wizard.step2.customBadge")}
                  </span>
                )}
              </span>
              <span className={`truncate font-mono text-[10.5px] transition-colors
                ${isSelected
                  ? "text-accent-500/70 dark:text-accent-400/70"
                  : "text-gray-400 dark:text-white/35"}`}>
                {agent.command}
              </span>
              {agent.version && (
                <span className="truncate font-mono text-[10.5px] text-gray-400 dark:text-gray-500">
                  {agent.version}
                </span>
              )}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/** O fundo do ícone de cada agente (estilo app do iOS). */
function agentTile(id: string): string {
  if (id.startsWith("claude")) return "linear-gradient(180deg,#e08a6c,#c96442)";
  if (id.startsWith("codex")) return "linear-gradient(180deg,#3a3a3c,#1c1c1e)";
  if (id.startsWith("antigravity") || id.startsWith("gemini")) return "linear-gradient(135deg,#4285f4,#9b72cb)";
  if (id.startsWith("opencode")) return "linear-gradient(180deg,#5e5ce6,#3634a3)";
  if (id.startsWith("kimi")) return "linear-gradient(180deg,#30b0c7,#0a7d93)";
  return "linear-gradient(180deg,#636366,#48484a)";
}
