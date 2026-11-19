/** Categorias do `simslim --except`; as descrições explicam quais serviços cada opção mantém ligados. */
export const SIMULATOR_CATEGORIES = [
  { id: "widgets", name: "simulator.category.widgets", description: "simulator.category.widgetsDescription" },
  { id: "siri", name: "simulator.category.siri", description: "simulator.category.siriDescription" },
  { id: "search", name: "simulator.category.search", description: "simulator.category.searchDescription" },
  { id: "icloud", name: "simulator.category.icloud", description: "simulator.category.icloudDescription" },
  { id: "store", name: "simulator.category.store", description: "simulator.category.storeDescription" },
  { id: "pim", name: "simulator.category.pim", description: "simulator.category.pimDescription" },
  { id: "web", name: "simulator.category.web", description: "simulator.category.webDescription" },
  { id: "family", name: "simulator.category.family", description: "simulator.category.familyDescription" },
  { id: "health", name: "simulator.category.health", description: "simulator.category.healthDescription" },
  { id: "photos", name: "simulator.category.photos", description: "simulator.category.photosDescription" },
  { id: "apps", name: "simulator.category.apps", description: "simulator.category.appsDescription" },
  { id: "messaging", name: "simulator.category.messaging", description: "simulator.category.messagingDescription" },
  { id: "connectivity", name: "simulator.category.connectivity", description: "simulator.category.connectivityDescription" },
  { id: "telemetry", name: "simulator.category.telemetry", description: "simulator.category.telemetryDescription" },
  { id: "mdm", name: "simulator.category.mdm", description: "simulator.category.mdmDescription" },
] as const;

export type SimulatorCategoryId = (typeof SIMULATOR_CATEGORIES)[number]["id"];

export const SIMULATOR_CATEGORY_IDS: readonly string[] = SIMULATOR_CATEGORIES.map(({ id }) => id);
