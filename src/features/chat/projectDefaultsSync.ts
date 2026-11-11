import { adoptBackendDefaults, localProjectPaths, projectDefaultsDto } from "./chatProjectPrefs";
import { commitProjectDefaults, getProjectDefaults, hydrateProjectDefaults, isEmptyDefaults, notifyProjectDefaults, useProjectDefaultsStore } from "./projectDefaultsStore";
import type { ProjectChatDefaultsDto } from "./projectChatDefaults";

const same = (a: ProjectChatDefaultsDto, b: ProjectChatDefaultsDto | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Concilia os padrões por projeto do aparelho (o que o composer lê, síncrono) com os do banco (o que o backend e outros
 * aparelhos leem). Só soma, nunca apaga:
 * - o que o banco tem e o aparelho não (instalação nova, localStorage limpo) entra no aparelho;
 * - o que o aparelho tem e o banco não (padrões de antes de existir o banco) vai para o banco.
 * Quando os dois têm o campo, vale o do aparelho (é o que a pessoa vê e edita). Idempotente.
 */
export async function syncProjectDefaults(): Promise<void> {
  await hydrateProjectDefaults();
  for (const dto of Object.values(useProjectDefaultsStore.getState().byKey)) {
    if (adoptBackendDefaults(dto)) notifyProjectDefaults(dto.cwd);
  }
  for (const path of localProjectPaths()) {
    const want = projectDefaultsDto(path);
    if (isEmptyDefaults(want) && !getProjectDefaults(path)) continue;
    if (same(want, getProjectDefaults(path))) continue;
    await commitProjectDefaults(want, { notify: false }).catch(() => undefined);
  }
}
