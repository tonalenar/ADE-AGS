import { invoke } from "@tauri-apps/api/core";

/**
 * Título da conversa gerado por modelo e retomada depois do limite de uso
 * (`src-tauri/src/conversa/titulo.rs` e `conversa/limite.rs`). Tudo local: nenhum serviço novo.
 */
export interface TitleSettingsDto {
  /** Gerar o título sozinho no fim do primeiro turno. */
  enabled: boolean;
  /** As instruções do título (tamanho, um id na frente…). */
  instructions: string;
  /** O agente que escreve o título; `null` = o da própria conversa. */
  agentId: string | null;
  /** O modelo desse agente; `null` = o padrão dele. */
  model: string | null;
}

export const chatTitleSettingsGet = () => invoke<TitleSettingsDto>("chat_title_settings_get");
export const chatTitleSettingsSet = (settings: TitleSettingsDto) => invoke<TitleSettingsDto>("chat_title_settings_set", { settings });
/** Os agentes que escrevem título sem terminal (os que rodam somente leitura). */
export const chatTitleWriters = () => invoke<string[]>("chat_title_writers");
/** «Regerar título» do menu da conversa: devolve o título novo. */
export const chatThreadRegenerateTitle = (threadId: string) => invoke<string>("chat_thread_regenerate_title", { threadId });

/** A retomada agendada de uma conversa que parou por limite de uso. */
export interface LimitResumePlan {
  threadId: string;
  /** Quando retoma (segundos). */
  at: number;
  createdAtMs: number;
}

export const chatLimitResumePrefGet = () => invoke<boolean>("chat_limit_resume_pref_get");
export const chatLimitResumePrefSet = (enabled: boolean) => invoke<void>("chat_limit_resume_pref_set", { enabled });
export const chatLimitResumeGet = (threadId: string) => invoke<LimitResumePlan | null>("chat_limit_resume_get", { threadId });
export const chatLimitResumeCancel = (threadId: string) => invoke<void>("chat_limit_resume_cancel", { threadId });
