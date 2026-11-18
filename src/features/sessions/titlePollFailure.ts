/** Falhas seguidas do poll de título: a primeira só avisa no console; a segunda pede toast. */
export function noteTitlePollFailure(consecutive: number): { consecutive: number; notify: boolean } {
  const next = consecutive + 1;
  return { consecutive: next, notify: next >= 2 };
}
