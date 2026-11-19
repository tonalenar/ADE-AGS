export interface ProjectExceptions {
  global: string[];
  projects: Record<string, string[]>;
}

/** Normaliza a mesma pasta independentemente do separador usado pelo sistema. */
export function projectKey(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function exceptionsForProject(global: string[], projects: Record<string, string[]>, cwd: string): string[] {
  const key = projectKey(cwd);
  return key ? projects[key] ?? global : global;
}

export function withProjectExceptions(current: ProjectExceptions, cwd: string, exceptions: string[]): ProjectExceptions {
  const key = projectKey(cwd);
  return key
    ? { ...current, projects: { ...current.projects, [key]: exceptions } }
    : { ...current, global: exceptions };
}
