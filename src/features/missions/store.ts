/**
 * Las misiones en el frontend: un reflejo de SQLite, como la flota.
 *
 * No hay polling. Lo que cambia una misión en curso es que cambie una de sus tareas, y eso
 * ya lo avisa el supervisor con `cc-task-changed`; al recibirlo se relee la lista (una
 * consulta) y el detalle abierto. Crear, editar, arrancar, cerrar y cancelar la avisan con
 * `cc-mission-changed`, así otra ventana se entera de lo que se hizo en esta.
 */
import { create } from "zustand";

import * as ipc from "./ipc";
import type { Mission, MissionDetail, MissionInput, MissionSummary } from "./types";

interface MissionsState {
  missions: MissionSummary[];
  /** El detalle de las misiones que se abrieron, por id. */
  details: Record<string, MissionDetail>;
  loaded: boolean;
  load: (workspaceId: string) => Promise<void>;
  loadDetail: (missionId: string) => Promise<MissionDetail>;
  create: (workspaceId: string, input: MissionInput) => Promise<Mission>;
  update: (workspaceId: string, missionId: string, input: MissionInput) => Promise<Mission>;
  start: (workspaceId: string, missionId: string) => Promise<Mission>;
  cancel: (workspaceId: string, missionId: string) => Promise<Mission>;
  /** Una tarea cambió: se relee la lista y, si hay uno abierto, su detalle. */
  onTaskChanged: (workspaceId: string, openMissionId: string | null) => Promise<void>;
  /** Una misión cambió: se relee la lista, y su detalle solo si es la abierta. */
  onMissionChanged: (workspaceId: string, missionId: string, openMissionId: string | null) => Promise<void>;
}

/**
 * Un evento que llega mientras otro refresco está en vuelo no dispara un segundo en
 * paralelo: se anota y se relee una vez más al terminar. Una tarea que arranca y termina
 * emite varios eventos seguidos, y sin esto cada uno haría su propio viaje.
 */
let inFlight: Promise<void> | null = null;
let again = false;

export const useMissionsStore = create<MissionsState>((set, get) => {
  const refresh = async (workspaceId: string, missionId: string | null) => {
    const [missions, detail] = await Promise.all([
      ipc.listMissions(workspaceId),
      missionId ? ipc.getMission(missionId) : Promise.resolve(null),
    ]);
    set((s) => ({
      missions,
      loaded: true,
      details: detail ? { ...s.details, [detail.mission.id]: detail } : s.details,
    }));
  };

  return {
    missions: [],
    details: {},
    loaded: false,

    load: (workspaceId) => refresh(workspaceId, null),

    loadDetail: async (missionId) => {
      const detail = await ipc.getMission(missionId);
      set((s) => ({ details: { ...s.details, [missionId]: detail } }));
      return detail;
    },

    create: async (workspaceId, input) => {
      const mission = await ipc.createMission(workspaceId, input);
      await refresh(workspaceId, mission.id);
      return mission;
    },

    update: async (workspaceId, missionId, input) => {
      const mission = await ipc.updateMission(missionId, input);
      await refresh(workspaceId, missionId);
      return mission;
    },

    start: async (workspaceId, missionId) => {
      try {
        return await ipc.startMission(missionId);
      } finally {
        // También si falló: el lead pudo no arrancar después de creado el run, y la misión
        // queda `failed` con el motivo. Eso tiene que verse, no solo el error del toast.
        await refresh(workspaceId, missionId).catch(() => {});
      }
    },

    cancel: async (workspaceId, missionId) => {
      try {
        return await ipc.cancelMission(missionId);
      } finally {
        await refresh(workspaceId, missionId).catch(() => {});
      }
    },

    onTaskChanged: async (workspaceId, openMissionId) => {
      if (inFlight) {
        again = true;
        return inFlight;
      }
      inFlight = (async () => {
        try {
          do {
            again = false;
            await refresh(workspaceId, openMissionId);
          } while (again);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },

    onMissionChanged: (workspaceId, missionId, openMissionId) => {
      if (missionId !== openMissionId && get().details[missionId]) {
        // Uno cerrado que quedó viejo: se vuelve a pedir al abrirlo, no ahora.
        set((s) => {
          const { [missionId]: _stale, ...details } = s.details;
          return { details };
        });
      }
      return get().onTaskChanged(workspaceId, missionId === openMissionId ? openMissionId : null);
    },
  };
});

/** Para los tests: olvidar lo que quedó de uno anterior. */
export function resetMissionsStore() {
  inFlight = null;
  again = false;
  useMissionsStore.setState({ missions: [], details: {}, loaded: false });
}
