//! Built-in functional roles. These describe the work; provider selection belongs to a
//! SquadMember. The catalog is declarative so a persisted role id can later be extended
//! with user-defined roles without changing Task's execution-role contract.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FunctionalRole {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub instructions: &'static str,
}

pub const BUILTIN_ROLES: &[FunctionalRole] = &[
 FunctionalRole{id:"dreamer",label:"Dreamer",description:"Read historical evidence and propose memory maintenance.",instructions:crate::memory::dream::SYSTEM_PROMPT},
    FunctionalRole {
        id: "backend",
        label: "Backend",
        description: "Server-side logic, APIs, data access, and backend tests.",
        instructions: "Implement server-side logic, APIs, data access and backend tests. Do not change unrelated frontend code unless required by the task.",
    },
    FunctionalRole {
        id: "frontend",
        label: "Frontend",
        description: "Client-side interfaces, interactions, and frontend tests.",
        instructions: "Implement client-side interfaces, interactions and frontend tests. Keep changes focused on the requested user experience and its integration points.",
    },
    FunctionalRole {
        id: "qa",
        label: "QA / Tests",
        description: "Test coverage, verification, and reproducible defect reports.",
        instructions: "QA em fluxo: validar cada entrega de integrante assim que chega ('ags peer tell') com 'ags test affected'. Validação final = UMA execução completa da integração (ou aguardar CI via 'gh pr checks <n> --watch', sem polling com sleep). Agentes não repetem suíte completa local; suíte completa local somente sob risco (migração de banco, unsafe/COM, schema). Manter alterações focadas em testes.",
    },
    FunctionalRole {
        id: "reviewer",
        label: "Reviewer",
        description: "Review completed work for defects, regressions, and missing tests.",
        instructions: "Review completed work. Prefer finding defects, regressions and missing tests. Do not rewrite code unless the task explicitly asks for fixes.",
    },
    FunctionalRole {
        id: "researcher",
        label: "Researcher",
        description: "Investigate code, APIs, constraints, and options; report evidence and findings.",
        instructions: "Investigate the requested subject and report evidence, constraints, and useful options. Prefer read-only inspection; do not modify project files unless the task explicitly asks you to produce an artifact.",
    },
    FunctionalRole {
        id: "devops",
        label: "DevOps",
        description: "Build, CI, packaging, deployment configuration, and operational tooling.",
        instructions: "Handle build, CI, packaging, deployment configuration and operational tooling. Keep changes scoped to the delivery and runtime systems needed by the task.",
    },
    FunctionalRole {
        id: "integrator",
        label: "Integrator",
        description: "Combine worker branches, resolve conflicts, run final validation, and prepare the integrated result.",
        instructions: "Integrate the assigned worker branches, resolve conflicts, run final validation, and prepare the combined result. Preserve each worker's intended changes and report any conflict decisions.",
    },
    FunctionalRole {
        id: "generalist",
        label: "Generalist",
        description: "Handle work that does not fit a configured specialist role.",
        instructions: "Complete the assigned task across the relevant parts of the project. Keep the scope focused, check related code before editing, and report what you verified.",
    },
];

pub fn get(id: &str) -> Option<&'static FunctionalRole> {
    BUILTIN_ROLES.iter().find(|role| role.id == id)
}

#[tauri::command]
pub fn functional_roles_list() -> Vec<FunctionalRole> {
    BUILTIN_ROLES.to_vec()
}

#[tauri::command]
pub fn functional_role_get(role_id: String) -> Result<FunctionalRole, String> {
    get(&role_id)
        .copied()
        .ok_or_else(|| format!("functional role '{role_id}' does not exist"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn built_in_catalog_has_unique_complete_roles_and_lookup() {
        let ids: HashSet<_> = BUILTIN_ROLES.iter().map(|role| role.id).collect();
        assert_eq!(ids.len(), 9);
        assert_eq!(
            ids,
            [
                "dreamer",
                "backend",
                "frontend",
                "qa",
                "reviewer",
                "researcher",
                "devops",
                "integrator",
                "generalist"
            ]
            .into_iter()
            .collect()
        );
        for role in BUILTIN_ROLES {
            assert!(!role.label.is_empty());
            assert!(!role.description.is_empty());
            assert!(!role.instructions.is_empty());
            assert_eq!(get(role.id), Some(role));
        }
        assert!(get("mobile").is_none());
    }
}
