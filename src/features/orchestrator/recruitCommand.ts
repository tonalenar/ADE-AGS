import { withAutonomy, type Autonomy } from "@/features/missions/autonomy";
import { withModel } from "@/features/missions/modelFlags";

/**
 * El comando con el que arranca un agente sumado por una orquestadora (`ags peer recruit`):
 * el nivel de permisos elegido (sin eso pedía confirmación en cada paso y el equipo esperaba) y
 * el modelo y esfuerzo pedidos (sin eso abría con el predeterminado de la TUI). Pura.
 */
export function recruitCommand(
  agentId: string,
  command: string,
  level: Autonomy,
  model?: string | null,
  effort?: string | null,
): string {
  return withModel(agentId, withAutonomy(agentId, command, level), model, effort);
}
