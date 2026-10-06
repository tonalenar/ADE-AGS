/**
 * Contrato de la resolución de conflictos de integración (Etapa 21, ítem 7c).
 * DTOs en camelCase.
 *
 * Comandos Tauri esperados (wrappers en `conflictsIpc.ts`):
 *  - `mission_conflicts(missionId)  -> IntegrationConflicts`
 *      Tras `merge origin/master` en la rama de integración, lista los archivos sin resolver.
 *  - `mission_resolve_conflict(missionId, path, content) -> IntegrationConflicts`
 *      Escribe el contenido FINAL (sin marcadores; lo calcula el front con `conflicts.ts`)
 *      y hace `git add`. Rechaza contenido que aún tenga marcadores.
 *  - `mission_conclude_merge(missionId) -> void`
 *      Cuando no quedan conflictos, hace el commit del merge.
 */

export interface ConflictFile {
  path: string;
  /** Contenido del working tree con los marcadores `<<<<<<<`/`=======`/`>>>>>>>`. */
  content: string;
  /** Binario: no se puede mostrar ni fusionar acá. */
  binary: boolean;
}

export interface IntegrationConflicts {
  missionId: string;
  /** Rama de integración de la misión y la rama con la que se fusiona (`origin/master`). */
  branch: string;
  against: string;
  files: ConflictFile[];
}
