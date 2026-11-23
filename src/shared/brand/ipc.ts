import { invoke } from "@tauri-apps/api/core";

import type { PetStatus } from "./Pet";

/** O que o backend sabe do pet (`pet.rs`, `pet_status`). */
export const petStatus = () => invoke<PetStatus>("pet_status");
