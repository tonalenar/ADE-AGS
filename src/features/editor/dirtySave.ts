/** Depois de gravar: se o editor mudou durante a escrita, continua sujo. */
export function dirtyAfterSuccessfulSave(docWhenSaveStarted: string, docNow: string): boolean {
  return docNow !== docWhenSaveStarted;
}

/** Releitura do disco só entra no editor se a pessoa não digitou no meio. */
export function applyDiskReload(dirty: boolean, intoEditor: boolean): boolean {
  return intoEditor && !dirty;
}
