//! Lo que una tarea puede hacer según su papel en el run.
//!
//! El lead coordina: entiende el proyecto, consulta el roster, arma el DAG, reparte, espera
//! y consolida. No hace el trabajo de los workers. Eso no se deja solo al prompt —un modelo
//! puede decidir escribir igual, y ya pasó—: se hace cumplir en dos lugares.
//!
//! - **El broker** ([`super::broker::resolve`]) contesta que no, en el acto y sin encolar, a
//!   todo pedido de un lead que no esté en [`lead_may_use`]. Va antes que las reglas de la
//!   carpeta: ni una regla recordada ni un "Allow" de la consola pueden devolverle la
//!   escritura, porque el pedido nunca llega a la consola.
//! - **El lanzamiento**: cada TUI recibe `read_only` en su [`super::agents::LaunchCtx`] y lo
//!   traduce a lo suyo (tools prohibidas, sandbox de solo lectura, permisos en `deny`). Hace
//!   falta porque no todas le preguntan al broker: Codex y OpenCode deciden solas.
//!
//! La regla es por papel (`role == lead`), nunca por provider: un Claude Code de una tarea
//! manual o de un worker escribe como siempre.

use super::types::{role, Task};

/// Lo que se le contesta a un lead que intenta tocar el workspace.
pub const LEAD_DENIED: &str = "Lead tasks cannot modify the workspace directly. \
Delegate implementation to a worker using run_plan/task_add.";

/// Si la tarea coordina y no puede modificar el workspace.
pub fn is_coordinator(task: &Task) -> bool {
    task.role.as_deref() == Some(role::LEAD)
}

/// Herramientas de las TUIs que solo miran. Nada de shell: sin una clasificación confiable
/// de comandos de solo lectura, un lead sin `Bash` es mejor que una garantía falsa.
const READ_ONLY_BUILTINS: &[&str] = &[
    "Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch",
    // La lista de pendientes interna del agente: no toca el workspace.
    "TodoWrite",
];

/// Lo que se le prohíbe al lead en el lanzamiento, en las TUIs que aceptan una lista.
pub const LEAD_BLOCKED_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"];

/// Si un lead puede usar esta herramienta.
///
/// Permitido: leer y buscar, y las del servidor de ADE AGS que orquestan o solo miran
/// (roster, plan, tareas, hechos, esperar resultados; navegador y git de solo lectura).
/// Todo lo demás —escribir, editar, shell, git que escribe, subagentes, herramientas que
/// no se conocen— no: ante la duda, no toca nada.
pub fn lead_may_use(tool_name: &str) -> bool {
    if READ_ONLY_BUILTINS.iter().any(|t| t.eq_ignore_ascii_case(tool_name)) {
        return true;
    }
    if tool_name == crate::ipc::mcp::orchestration_tool_name("task_handoff") { return false; }
    let ours = format!("mcp__{}__", crate::ipc::mcp::SERVER_NAME);
    match tool_name.strip_prefix(&ours) {
        Some(name) => crate::ipc::mcp::is_orchestration_tool(name) || crate::ipc::mcp::is_read_only(name),
        None => false,
    }
}
