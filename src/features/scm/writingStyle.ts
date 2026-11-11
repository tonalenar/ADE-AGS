export type CommitWritingMode = "conventional" | "repository" | "plain";
export type CommitWritingLanguage = "pt-BR" | "en" | "es";

export interface CommitWritingPreferences {
  mode: CommitWritingMode;
  language: CommitWritingLanguage;
  customInstructions: string;
}

const KEY = "ade-ags-scm-writing-style";
export const DEFAULT_COMMIT_WRITING_PREFERENCES: CommitWritingPreferences = {
  mode: "conventional",
  language: "pt-BR",
  customInstructions: "",
};

export function readCommitWritingPreferences(): CommitWritingPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<CommitWritingPreferences> | null;
    return {
      mode: value?.mode === "repository" || value?.mode === "plain" ? value.mode : "conventional",
      language: value?.language === "en" || value?.language === "es" ? value.language : "pt-BR",
      customInstructions: typeof value?.customInstructions === "string" ? value.customInstructions.slice(0, 1000) : "",
    };
  } catch {
    return DEFAULT_COMMIT_WRITING_PREFERENCES;
  }
}

export function writeCommitWritingPreferences(preferences: CommitWritingPreferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // A preferência continua valendo na tela mesmo se o armazenamento local estiver indisponível.
  }
}
