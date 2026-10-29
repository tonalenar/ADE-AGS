import { MonitorIcon, BoxIcon } from "neogestify-ui-components";

import { CodexIcon, CursorIcon, HermesAgentIcon, OpenCodeIcon } from "./brandIcons";
import { AntigravityColorIcon, ClaudeCodeColorIcon, GeminiColorIcon, KimiColorIcon } from "./brandColorIcons";

type AgentIconComponent = (props: { className: string }) => React.JSX.Element;

/**
 * Icono de cada agente soportado, por el `id` que les asigna la auto-detección
 * (ver `agents/detector.rs`): o logo oficial de cada um, nas cores originais (`brandColorIcons.tsx`). Codex (o logo da OpenAI), OpenCode e Hermes não
 * têm versão colorida (a marca deles é de uma cor só): seguem a cor do texto (`brandIcons.tsx`). A terminal pura, um monitor.
 */
const BY_ID: Record<string, AgentIconComponent> = {
  "claude-code": ClaudeCodeColorIcon,
  "gemini-cli": GeminiColorIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
  "kimi-code": KimiColorIcon,
  hermes: HermesAgentIcon,
  cursor: CursorIcon,
  antigravity: AntigravityColorIcon,
  bash: MonitorIcon,
};

/** Agentes custom: no tienen un id conocido, así que se infiere por su comando. */
const BY_COMMAND_HINT: [string, AgentIconComponent][] = [
  ["claude", ClaudeCodeColorIcon],
  ["gemini", GeminiColorIcon],
  ["codex", CodexIcon],
  ["opencode", OpenCodeIcon],
  ["kimi", KimiColorIcon],
  ["hermes", HermesAgentIcon],
  ["cursor-agent", CursorIcon],
  ["cursor", CursorIcon],
  ["antigravity", AntigravityColorIcon],
  ["agy", AntigravityColorIcon],
  ["bash", MonitorIcon],
  ["zsh", MonitorIcon],
  ["fish", MonitorIcon],
  ["sh", MonitorIcon],
];

/**
 * Icono a mostrar para un agente. Nunca devuelve `null`: un agente desconocido
 * (custom con un comando que no reconocemos) cae en un icono neutro, para que la grilla
 * del Home no quede con huecos desalineados.
 */
export function agentIcon(agentId: string, command?: string): AgentIconComponent {
  const byId = BY_ID[agentId];
  if (byId) return byId;

  const haystack = `${agentId} ${command ?? ""}`.toLowerCase();
  const hit = BY_COMMAND_HINT.find(([hint]) => haystack.includes(hint));
  return hit ? hit[1] : BoxIcon;
}
