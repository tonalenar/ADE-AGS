import { MonitorIcon, BoxIcon } from "neogestify-ui-components";

import {
  AntigravityIcon,
  ClaudeCodeIcon,
  CodexIcon,
  GeminiCliIcon,
  HermesAgentIcon,
  KimiIcon,
  OpenCodeIcon,
} from "./brandIcons";

type AgentIconComponent = (props: { className: string }) => React.JSX.Element;

/**
 * Icono de cada agente soportado, por el `id` que les asigna la auto-detección
 * (ver `agents/detector.rs`): o logo oficial de cada um (`brandIcons.tsx`); a terminal pura, um monitor.
 */
const BY_ID: Record<string, AgentIconComponent> = {
  "claude-code": ClaudeCodeIcon,
  "gemini-cli": GeminiCliIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
  "kimi-code": KimiIcon,
  hermes: HermesAgentIcon,
  antigravity: AntigravityIcon,
  bash: MonitorIcon,
};

/** Agentes custom: no tienen un id conocido, así que se infiere por su comando. */
const BY_COMMAND_HINT: [string, AgentIconComponent][] = [
  ["claude", ClaudeCodeIcon],
  ["gemini", GeminiCliIcon],
  ["codex", CodexIcon],
  ["opencode", OpenCodeIcon],
  ["kimi", KimiIcon],
  ["hermes", HermesAgentIcon],
  ["antigravity", AntigravityIcon],
  ["agy", AntigravityIcon],
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
