//! Papéis prontos para os agentes do canvas: o que cada um é e como se comporta.
//!
//! Um papel é um texto de instruções. Quando um orquestrador recruta com `--role`, o
//! agente novo recebe esse texto antes da primeira tarefa, e o nó dele no canvas leva o
//! nome do papel.
//!
//! Há dois tipos:
//! - **Do catálogo** (`crate::roles`): os papéis funcionais que as missões já usam
//!   (backend, frontend, qa, reviewer…). Não mudam. É o mesmo texto nos dois lugares: um
//!   "reviewer" no canvas se comporta como o "reviewer" de uma missão.
//! - **Do usuário**: criados com `ags role create`, guardados em
//!   `~/.ags/canvas-roles.json`. Só um orquestrador cria ou edita: um papel é uma
//!   instrução que vai para todo agente futuro, não algo que qualquer um deva poder mudar.
//!
//! A lógica é pura (sobre uma lista) e o arquivo é uma casca fina por cima, para testar sem
//! tocar na pasta do usuário.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Quanto cabe num papel. Mais que isso é um manual: vai numa nota.
const MAX_INSTRUCTIONS: usize = 4000;
const MAX_LABEL: usize = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Role {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub instructions: String,
    /// Do catálogo: não se edita. Não vai no arquivo.
    #[serde(default, skip_serializing)]
    pub builtin: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct RolesFile {
    #[serde(default)]
    roles: Vec<Role>,
}

lazy_static::lazy_static! {
    static ref LOCK: Mutex<()> = Mutex::new(());
}

fn file_path() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("Não foi possível achar a pasta do usuário")?.join(".ags");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("canvas-roles.json"))
}

fn read_custom() -> Vec<Role> {
    let Ok(path) = file_path() else { return Vec::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RolesFile>(&raw).ok())
        .map(|f| f.roles)
        .unwrap_or_default()
}

fn write_custom(roles: &[Role]) -> Result<(), String> {
    let path = file_path()?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&RolesFile { roles: roles.to_vec() }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn builtin() -> Vec<Role> {
    crate::roles::BUILTIN_ROLES
        .iter()
        .map(|r| Role { id: r.id.into(), label: r.label.into(), instructions: r.instructions.into(), builtin: true })
        .collect()
}

/// O catálogo e depois os do usuário.
pub fn all() -> Vec<Role> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    combine(read_custom())
}

fn combine(custom: Vec<Role>) -> Vec<Role> {
    let mut roles = builtin();
    roles.extend(custom.into_iter().map(|r| Role { builtin: false, ..r }));
    roles
}

/// `Revisor de Segurança` → `revisor-de-seguranca`. Só letras e números ASCII; o resto vira
/// separador. Sem acentos: o id se escreve numa linha de comando.
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.trim().chars() {
        let folded = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            other => other,
        };
        if folded.is_ascii_alphanumeric() {
            out.push(folded.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Acha um papel por id ou por nome (sem maiúsculas).
pub fn resolve<'a>(roles: &'a [Role], wanted: &str) -> Result<&'a Role, String> {
    let needle = wanted.trim().to_lowercase();
    let slugged = slug(wanted);
    roles
        .iter()
        .find(|r| r.id == needle || r.id == slugged || r.label.to_lowercase() == needle)
        .ok_or_else(|| {
            format!(
                "Não existe o papel '{wanted}'. Papéis: {}. Veja `ags roles`.",
                roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", ")
            )
        })
}

fn check(label: &str, instructions: &str) -> Result<(), String> {
    if label.trim().is_empty() {
        return Err("O papel precisa de um nome.".into());
    }
    if label.chars().count() > MAX_LABEL {
        return Err(format!("O nome do papel passa de {MAX_LABEL} caracteres."));
    }
    if slug(label).is_empty() {
        return Err("O nome do papel precisa ter letras ou números.".into());
    }
    if instructions.trim().is_empty() {
        return Err("O papel precisa de instruções: diga como esse agente deve trabalhar.".into());
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS {
        return Err(format!("As instruções passam de {MAX_INSTRUCTIONS} caracteres. Resuma ou use uma nota."));
    }
    Ok(())
}

/// Soma um papel do usuário a `roles` (que já tem o catálogo). O id sai do nome e não pode
/// repetir outro: nem do catálogo nem do usuário.
pub fn with_created(roles: &[Role], label: &str, instructions: &str) -> Result<(Vec<Role>, Role), String> {
    check(label, instructions)?;
    let id = slug(label);
    if roles.iter().any(|r| r.id == id) {
        return Err(format!("Já existe um papel '{id}'. Use `ags role edit` ou escolha outro nome."));
    }
    let role = Role { id, label: label.trim().to_string(), instructions: instructions.trim().to_string(), builtin: false };
    let mut next = roles.to_vec();
    next.push(role.clone());
    Ok((next, role))
}

/// Edita um papel do usuário. O id não muda (agentes já recrutados o citam); o catálogo
/// não se edita.
pub fn with_edited(
    roles: &[Role],
    wanted: &str,
    label: Option<&str>,
    instructions: Option<&str>,
) -> Result<(Vec<Role>, Role), String> {
    let target = resolve(roles, wanted)?;
    if target.builtin {
        return Err(format!(
            "'{}' é um papel do catálogo e não se edita. Crie um parecido com `ags role create`.",
            target.id
        ));
    }
    let next_label = label.unwrap_or(&target.label).to_string();
    let next_instructions = instructions.unwrap_or(&target.instructions).to_string();
    check(&next_label, &next_instructions)?;
    let edited = Role { id: target.id.clone(), label: next_label.trim().to_string(), instructions: next_instructions.trim().to_string(), builtin: false };
    let next = roles.iter().map(|r| if r.id == edited.id { edited.clone() } else { r.clone() }).collect();
    Ok((next, edited))
}

/// Cria e guarda um papel do usuário.
pub fn create(label: &str, instructions: &str) -> Result<Role, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let custom = read_custom();
    let (next, role) = with_created(&combine(custom), label, instructions)?;
    write_custom(&only_custom(&next))?;
    Ok(role)
}

/// Edita e guarda um papel do usuário.
pub fn edit(wanted: &str, label: Option<&str>, instructions: Option<&str>) -> Result<Role, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (next, role) = with_edited(&combine(read_custom()), wanted, label, instructions)?;
    write_custom(&only_custom(&next))?;
    Ok(role)
}

fn only_custom(roles: &[Role]) -> Vec<Role> {
    roles.iter().filter(|r| !r.builtin).cloned().collect()
}

/// O que um agente novo lê antes da primeira tarefa: o papel, e que a tarefa vem depois.
pub fn briefing(role: &Role) -> String {
    format!("Seu papel neste time: {} — {}", role.label, role.instructions)
}

#[cfg(test)]
mod test {
    use super::*;

    fn roles() -> Vec<Role> {
        combine(vec![])
    }

    #[test]
    fn o_id_sai_do_nome_sem_acentos_nem_simbolos() {
        assert_eq!(slug("Revisor de Segurança"), "revisor-de-seguranca");
        assert_eq!(slug("  QA / E2E!! "), "qa-e2e");
        assert_eq!(slug("!!!"), "");
    }

    #[test]
    fn acha_por_id_ou_por_nome_sem_maiusculas() {
        let r = roles();
        assert_eq!(resolve(&r, "reviewer").unwrap().id, "reviewer");
        assert_eq!(resolve(&r, "QA / Tests").unwrap().id, "qa");
        assert_eq!(resolve(&r, "BACKEND").unwrap().id, "backend");
        let err = resolve(&r, "chef").unwrap_err();
        assert!(err.contains("reviewer") && err.contains("ags roles"), "{err}");
    }

    #[test]
    fn cria_um_papel_do_usuario_e_o_acha_depois() {
        let (next, role) = with_created(&roles(), "Revisor de Segurança", "Procure falhas de segurança.").unwrap();
        assert_eq!(role.id, "revisor-de-seguranca");
        assert!(!role.builtin);
        assert_eq!(resolve(&next, "revisor de segurança").unwrap().id, role.id);
    }

    #[test]
    fn nao_cria_com_id_repetido_nem_vazio() {
        let (next, _) = with_created(&roles(), "Docs", "Escreva docs.").unwrap();
        assert!(with_created(&next, "docs", "outra").unwrap_err().contains("Já existe"));
        assert!(with_created(&roles(), "Backend", "x").unwrap_err().contains("Já existe"), "o catálogo conta");
        assert!(with_created(&roles(), "", "x").is_err());
        assert!(with_created(&roles(), "Docs", "  ").unwrap_err().contains("instruções"));
        assert!(with_created(&roles(), "!!!", "x").unwrap_err().contains("letras"));
        assert!(with_created(&roles(), "Docs", &"a".repeat(MAX_INSTRUCTIONS + 1)).is_err());
    }

    #[test]
    fn edita_um_papel_do_usuario_mantendo_o_id() {
        let (next, _) = with_created(&roles(), "Docs", "Escreva docs.").unwrap();
        let (after, edited) = with_edited(&next, "docs", Some("Documentação"), Some("Escreva docs claros.")).unwrap();
        assert_eq!(edited.id, "docs", "agentes já recrutados citam o id antigo");
        assert_eq!(edited.label, "Documentação");
        assert_eq!(resolve(&after, "docs").unwrap().instructions, "Escreva docs claros.");
        assert_eq!(after.len(), next.len());
    }

    #[test]
    fn o_catalogo_nao_se_edita() {
        let err = with_edited(&roles(), "reviewer", None, Some("faça outra coisa")).unwrap_err();
        assert!(err.contains("catálogo"), "{err}");
    }

    #[test]
    fn so_o_do_usuario_vai_para_o_arquivo() {
        let (next, _) = with_created(&roles(), "Docs", "Escreva docs.").unwrap();
        let custom = only_custom(&next);
        assert_eq!(custom.len(), 1);
        let json = serde_json::to_string(&RolesFile { roles: custom }).unwrap();
        assert!(!json.contains("builtin"), "{json}");
        let back: RolesFile = serde_json::from_str(&json).unwrap();
        assert_eq!(combine(back.roles).last().unwrap().id, "docs");
    }

    #[test]
    fn o_briefing_diz_o_papel() {
        let r = roles();
        let text = briefing(resolve(&r, "reviewer").unwrap());
        assert!(text.starts_with("Seu papel neste time: Reviewer"));
    }
}
