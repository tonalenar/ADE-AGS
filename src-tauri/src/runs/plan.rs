//! Lo que declara un lead: un plan de tareas con dependencias, validado antes de crear nada.
//!
//! Puro. El plan llega de un modelo, así que se valida entero y **se rechaza entero**: crear
//! la mitad de las tareas y fallar en la sexta dejaría un run a medias, con tareas que
//! esperan dependencias que nunca se crearon.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::routing::Complexity;

/// Cuántas tareas puede declarar un plan de una vez. Un lead que reparte en cincuenta
/// pedazos no está planificando, está delegando el pensar.
pub const MAX_TASKS: usize = 20;

/// Hasta qué profundidad se delega: el lead (0) reparte a workers (1), que pueden repartir
/// una vez más (2). Más abajo, el costo y lo difícil de seguir crecen más que lo que se gana.
pub const MAX_DEPTH: i64 = 2;

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct PlanTask {
    /// El nombre con el que el plan se refiere a la tarea: `api`, `tests-login`.
    pub key: String,
    pub title: String,
    pub prompt: String,
    /// Functional role. The planner-facing JSON can use the concise `role` key.
    #[serde(default, alias = "role")]
    pub functional_role: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub complexity: Option<Complexity>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Named account override. Squad assignments reject this along with provider/model.
    #[serde(default, alias = "account")]
    pub account_id: Option<String>,
    /// `None` = lo decide la app (aislada si el proyecto es un repo de git).
    #[serde(default)]
    pub isolate: Option<bool>,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// JSON Schema que tiene que cumplir el resultado.
    #[serde(default)]
    pub result_schema: Option<serde_json::Value>,
    /// Key, id ou work_key da entrega que esta tarefa corrige. O teto é o dela.
    #[serde(default, alias = "fixes")]
    pub corrects: Option<String>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 40
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Codex structured output requires closed objects and every property in required.
/// Reject incompatible schemas without rewriting their meaning or launching inference.
pub fn validate_result_schema(agent: &str, schema: &serde_json::Value) -> Result<(), String> {
    if agent != "codex" { return Ok(()); }
    if schema.get("type").and_then(serde_json::Value::as_str) != Some("object") {
        return Err("result_schema do Codex: a raiz deve ter type=object".into());
    }
    fn visit(schema: &serde_json::Value, path: &str) -> Result<(), String> {
        let Some(node) = schema.as_object() else {
            return Err(format!("result_schema do Codex em {path}: use um objeto de schema"));
        };
        let is_object = node.contains_key("properties") || node.get("type").is_some_and(|t| {
            t.as_str() == Some("object") || t.as_array().is_some_and(|types| types.iter().any(|t| t.as_str() == Some("object")))
        });
        if is_object {
            if node.get("additionalProperties") != Some(&serde_json::Value::Bool(false)) {
                return Err(format!("result_schema do Codex em {path}: additionalProperties deve ser false"));
            }
            let properties = node.get("properties").and_then(serde_json::Value::as_object)
                .ok_or_else(|| format!("result_schema do Codex em {path}: properties deve ser um objeto"))?;
            let required = node.get("required").and_then(serde_json::Value::as_array)
                .ok_or_else(|| format!("result_schema do Codex em {path}: required deve listar todas as propriedades"))?;
            let names: HashSet<&str> = required.iter().filter_map(serde_json::Value::as_str).collect();
            if names.len() != required.len() || names.len() != properties.len() || properties.keys().any(|key| !names.contains(key.as_str())) {
                return Err(format!("result_schema do Codex em {path}: required deve listar todas e somente as propriedades; use tipo nullable para campos opcionais"));
            }
        }
        for keyword in ["properties", "$defs", "definitions"] {
            if let Some(children) = node.get(keyword).and_then(serde_json::Value::as_object) {
                for (name, child) in children { visit(child, &format!("{path}.{keyword}.{name}"))?; }
            }
        }
        for keyword in ["items", "not"] {
            if let Some(child) = node.get(keyword) { visit(child, &format!("{path}.{keyword}"))?; }
        }
        for keyword in ["anyOf", "oneOf", "allOf"] {
            if let Some(children) = node.get(keyword).and_then(serde_json::Value::as_array) {
                for (index, child) in children.iter().enumerate() { visit(child, &format!("{path}.{keyword}[{index}]"))?; }
            }
        }
        Ok(())
    }
    visit(schema, "$")
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_rejects_open_objects_and_optional_properties_recursively() {
        let invalid = json!({"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]});
        assert!(validate_result_schema("codex", &invalid).unwrap_err().contains("additionalProperties"));
        let nested = json!({"type":"object","additionalProperties":false,"required":["items"],"properties":{"items":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"summary":{"type":"string"}},"required":[]}}}});
        let error = validate_result_schema("codex", &nested).unwrap_err();
        assert!(error.contains("$.properties.items.items"));
        assert!(error.contains("required"));
        assert!(validate_result_schema("claude-code", &invalid).is_ok());
    }

    #[test]
    fn codex_accepts_closed_nested_objects_nullable_properties_and_definitions() {
        let valid = json!({"type":"object","additionalProperties":false,"required":["summary","detail"],"properties":{"summary":{"type":"string"},"detail":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/detail"}]}},"$defs":{"detail":{"type":"object","additionalProperties":false,"properties":{"note":{"type":["string","null"]}},"required":["note"]}}});
        assert!(validate_result_schema("codex", &valid).is_ok());
        let mut invalid = valid.clone();
        invalid["$defs"]["detail"]["additionalProperties"] = json!(true);
        assert!(validate_result_schema("codex", &invalid).unwrap_err().contains("$.$defs.detail"));
        assert!(validate_result_schema("codex", &json!({"type":"array"})).is_err());
    }
}

/// Valida un plan contra las tareas que el run ya tiene (`existing`: sus claves).
///
/// Devuelve las tareas en un orden en el que cada una aparece después de sus dependencias
/// del mismo plan, que es el orden en que conviene crearlas. Los errores se juntan todos:
/// un modelo corrige mejor con la lista entera que de a uno por intento.
pub fn validate(tasks: &[PlanTask], existing: &HashSet<String>) -> Result<Vec<PlanTask>, String> {
    let mut errors = Vec::new();
    if tasks.is_empty() {
        return Err("el plan no tiene tareas".into());
    }
    if tasks.len() > MAX_TASKS {
        errors.push(format!("el plan tiene {} tareas; el máximo es {MAX_TASKS}", tasks.len()));
    }

    let mut seen = HashSet::new();
    for task in tasks {
        if !valid_key(&task.key) {
            errors.push(format!("'{}' no sirve como key: letras, números, - y _, hasta 40", task.key));
        }
        if !seen.insert(task.key.as_str()) {
            errors.push(format!("la key '{}' está repetida en el plan", task.key));
        } else if existing.contains(&task.key) {
            errors.push(format!("la key '{}' ya la usa otra tarea de este run", task.key));
        }
        if task.title.trim().is_empty() {
            errors.push(format!("'{}' no tiene título", task.key));
        }
        if task.prompt.trim().is_empty() {
            errors.push(format!("'{}' no tiene prompt", task.key));
        }
        if task.model.is_some() && task.agent.is_none() {
            errors.push(format!("'{}' nombra un modelo sin decir de qué agente", task.key));
        }
        if task.budget_usd.is_some_and(|b| b.is_nan() || b <= 0.0) {
            errors.push(format!("'{}' tiene un presupuesto que no es positivo", task.key));
        }
        for dep in &task.depends_on {
            if dep == &task.key {
                errors.push(format!("'{}' depende de sí misma", task.key));
            } else if !tasks.iter().any(|t| &t.key == dep) && !existing.contains(dep) {
                errors.push(format!("'{}' depende de '{dep}', que no existe", task.key));
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }

    topological(tasks)
}

/// Orden de Kahn sobre las dependencias internas del plan. Las que apuntan a tareas que ya
/// existían no cuentan: esas ya están creadas.
fn topological(tasks: &[PlanTask]) -> Result<Vec<PlanTask>, String> {
    let keys: HashSet<&str> = tasks.iter().map(|t| t.key.as_str()).collect();
    let mut pending: HashMap<&str, usize> = tasks
        .iter()
        .map(|t| (t.key.as_str(), t.depends_on.iter().filter(|d| keys.contains(d.as_str())).count()))
        .collect();

    let mut order = Vec::with_capacity(tasks.len());
    // En el orden en que vinieron: entre dos listas a la vez, respeta el del lead.
    while order.len() < tasks.len() {
        let Some(next) = tasks.iter().find(|t| pending.get(t.key.as_str()) == Some(&0)) else {
            let mut stuck: Vec<&str> = pending.keys().copied().collect();
            stuck.sort_unstable();
            return Err(format!("el plan tiene un ciclo entre: {}", stuck.join(", ")));
        };
        pending.remove(next.key.as_str());
        for t in tasks {
            if t.depends_on.iter().any(|d| d == &next.key)
                && let Some(n) = pending.get_mut(t.key.as_str())
            {
                *n -= 1;
            }
        }
        order.push(next.clone());
    }
    Ok(order)
}
