export const README_DEBOUNCE_MS = 200;

/** Cache curto do SKILL.md remoto, por repositório e entrada. */
export class SkillReadmeCache {
  private readonly values = new Map<string, string>();

  private key(registryId: string, skillId: string): string {
    return `${registryId}\0${skillId}`;
  }

  get(registryId: string, skillId: string): string | undefined {
    return this.values.get(this.key(registryId, skillId));
  }

  set(registryId: string, skillId: string, content: string): void {
    this.values.set(this.key(registryId, skillId), content);
  }

  clear(): void {
    this.values.clear();
  }
}

export const skillReadmeCache = new SkillReadmeCache();
