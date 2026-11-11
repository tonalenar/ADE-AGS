import { useEffect, useMemo } from "react";

import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";

import { useAgentsStore } from "./store";
import { useLocalAcpStore } from "./localAcpStore";
import { useProvidersStore } from "@/features/providers/store";

/**
 * Las TUIs que se pueden lanzar ahora mismo: las detectadas en el sistema más las que
 * agregó el usuario.
 *
 * Estaba escrito por separado en Home y en el wizard del "+", y las dos copias no
 * filtraban igual — Home descartaba las no instaladas ahí mismo y el wizard se lo dejaba
 * al paso de selección. Que las dos listas se armen acá evita que vuelvan a divergir.
 *
 * Las custom siempre cuentan como disponibles: su comando lo escribió el usuario, así que
 * no hay nada que detectar (si no existe, falla al lanzar, con su mensaje).
 */
export function useAvailableAgents({ includeLocalAcp = false }: { includeLocalAcp?: boolean } = {}): AgentInfo[] {
  const detectedAgents = useTabsStore((s) => s.detectedAgents);
  const customAgents = useAgentsStore((s) => s.customAgents);
  const localProviders = useLocalAcpStore((s) => s.providers);
  const localProvidersLoaded = useLocalAcpStore((s) => s.loaded);
  const loadLocalProviders = useLocalAcpStore((s) => s.load);
  // Provedores desligados em Configurações → Provedores não aparecem nos seletores de nova aba.
  const disabledProviders = useProvidersStore((s) => s.disabled);
  const providersLoaded = useProvidersStore((s) => s.loaded);
  const loadProviders = useProvidersStore((s) => s.load);
  useEffect(() => {
    if (!providersLoaded) void loadProviders().catch(console.error);
  }, [providersLoaded, loadProviders]);

  useEffect(() => {
    if (includeLocalAcp && !localProvidersLoaded) void loadLocalProviders().catch(console.error);
  }, [includeLocalAcp, loadLocalProviders, localProvidersLoaded]);

  return useMemo(
    () =>
      [
        ...detectedAgents,
        ...customAgents.map((ca) => ({
          id: ca.id,
          label: ca.label,
          command: ca.command,
          available: true,
          isCustom: true,
        })),
        ...(includeLocalAcp ? localProviders.map((provider) => ({
          id: provider.id,
          label: provider.label,
          command: "acp",
          available: true,
          isCustom: true,
          isStructured: true,
        })) : []),
      ].filter((a) => a.available && !disabledProviders.includes(a.id)),
    [detectedAgents, customAgents, includeLocalAcp, localProviders, disabledProviders]
  );
}
