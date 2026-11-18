/** A montagem já chama loadSkills(); o efeito da query vazia não pode disparar de novo. */
export function skipInitialEmptySkillsLoad(isFirstEffect: boolean, query: string): boolean {
  return isFirstEffect && query.trim() === "";
}
