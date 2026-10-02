//! Conversar con los agentes conectados en el canvas: `ccode peer list|ask|tell|check`.
//!
//! Es la misma maquinaria que `tab send` / `tab output` con dos diferencias:
//!
//! 1. **Permiso.** Un agente solo alcanza a los que están conectados con él en el canvas
//!    (ver `crate::canvas`). `tab send` sigue existiendo para quien orquesta a mano; esto
//!    es para que dos agentes trabajen juntos sin poder tocar al resto.
//! 2. **Por nombre y con quién habla.** Se apunta por el título de la tab, no por un id, y
//!    el mensaje le llega al otro con el nombre de quien lo manda — si no, el que recibe no
//!    tiene a quién contestar.
//!
//! Quién pregunta lo dice la variable `ADE_TAB_ID`, que la app le pone a cada terminal y
//! la CLI reenvía como `from`. No es una barrera de seguridad (un proceso puede mentir su
//! entorno): es el alcance de trabajo de cada agente, igual que la carpeta en la que corre.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::tabs::{pty_id_for_tab, submit_prompt, tab_create, tab_list, wait_for_pty, wait_until_quiet, wait_until_ready};
use crate::ipc::bridge::{ask_frontend, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt, arg_u64_opt};

/// Una tab abierta, con lo necesario para nombrarla y alcanzarla.
#[derive(Debug, Clone)]
pub(crate) struct OpenTab {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub cwd: String,
    pub window: String,
}

fn open_tabs(app: &AppHandle) -> Result<Vec<OpenTab>, String> {
    let listed = tab_list(app)?;
    let rows = listed.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|r| {
            let id = r.get("id")?.as_str()?.to_string();
            let agent = r.get("agentLabel").and_then(Value::as_str).unwrap_or("").to_string();
            let name = r
                .get("title")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| agent.clone());
            Some(OpenTab {
                id,
                name,
                agent,
                cwd: r.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
                window: r.get("window").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        })
        .collect())
}

fn caller(args: &Value) -> Result<String, String> {
    arg_str_opt(args, "from").filter(|s| !s.is_empty()).ok_or_else(|| {
        "Este comando só funciona dentro de um terminal do ADE AGS (falta ADE_TAB_ID).".to_string()
    })
}

/// Las tabs que `from` alcanza y siguen abiertas: sus vecinas o, si es orquestadora, todo
/// su equipo (ver `canvas::reachable`).
fn peers(app: &AppHandle, from: &str) -> Result<(Option<OpenTab>, Vec<OpenTab>), String> {
    let boards = crate::canvas::load_boards();
    let ids = crate::canvas::reachable(&boards, from);
    let tabs = open_tabs(app)?;
    let me = tabs.iter().find(|t| t.id == from).cloned();
    let list = tabs.into_iter().filter(|t| ids.contains(&t.id)).collect();
    Ok((me, list))
}

/// Resuelve `to` entre los conectados: por id o por nombre, sin mayúsculas. Un nombre que
/// apunta a dos tabs es un error y no una elección: mandarle el mensaje al equivocado es
/// peor que pedir el id.
pub(crate) fn resolve_peer<'a>(peers: &'a [OpenTab], to: &str) -> Result<&'a OpenTab, String> {
    if let Some(p) = peers.iter().find(|p| p.id == to) {
        return Ok(p);
    }
    let needle = to.trim().to_lowercase();
    let matches: Vec<&OpenTab> = peers.iter().filter(|p| p.name.to_lowercase() == needle).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] if peers.is_empty() => Err(format!(
            "'{to}' não está conectado com você. Você não tem nenhuma conexão no canvas: peça ao usuário para ligar os terminais."
        )),
        [] => Err(format!(
            "'{to}' não está conectado com você. Conectados: {}",
            peers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
        many => Err(format!(
            "Há {} agentes conectados chamados '{to}'. Use o id: {}",
            many.len(),
            many.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

fn describe(t: &OpenTab) -> Value {
    json!({ "id": t.id, "name": t.name, "agent": t.agent, "cwd": t.cwd })
}

/// El encabezado con el que llega un mensaje: quién lo manda y cómo contestar.
pub(crate) fn framed(from_name: &str, text: &str, expects_reply: bool) -> String {
    let how = if expects_reply {
        "Responda normalmente; sua resposta volta para quem perguntou quando você terminar.".to_string()
    } else {
        format!("Para responder, use: ccode peer tell \"{from_name}\" \"<mensagem>\"")
    };
    format!("[Mensagem de {from_name} via ADE AGS] {text}\n({how})")
}

pub(super) fn peer_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let (me, list) = peers(app, &from)?;
    let boards = crate::canvas::load_boards();
    let direct = crate::canvas::peers_of(&boards, &from);
    let flagged = |t: &OpenTab| {
        let mut v = describe(t);
        v["direct"] = json!(direct.contains(&t.id));
        v["orchestrator"] = json!(crate::canvas::is_orchestrator(&boards, &t.id));
        v
    };
    let you = me.as_ref().map(|m| {
        let mut v = describe(m);
        v["orchestrator"] = json!(crate::canvas::is_orchestrator(&boards, &m.id));
        v
    });
    Ok(json!({ "you": you, "peers": list.iter().map(flagged).collect::<Vec<_>>() }))
}

// ── Orquestadora ────────────────────────────────────────────────────

/// La tab que pide, si está marcada como orquestadora. Las acciones que cambian el equipo
/// (sumar un agente, conectar o desconectar) son solo suyas.
fn orchestrator(app: &AppHandle, args: &Value) -> Result<OpenTab, String> {
    let from = caller(args)?;
    if !crate::canvas::is_orchestrator(&crate::canvas::load_boards(), &from) {
        return Err("Só um orquestrador pode fazer isso. O usuário marca um agente como orquestrador no canvas (coroa no cabeçalho do nó).".into());
    }
    open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())
}

/// Con quiénes puede operar una orquestadora: su equipo y las demás tabs de su misma
/// carpeta (así suma al equipo a un agente que el usuario ya tenía abierto).
fn operable(app: &AppHandle, me: &OpenTab) -> Result<Vec<OpenTab>, String> {
    let team = crate::canvas::team_of(&crate::canvas::load_boards(), &me.id);
    Ok(open_tabs(app)?
        .into_iter()
        .filter(|t| t.id != me.id && (team.contains(&t.id) || t.cwd == me.cwd))
        .collect())
}

/// Resuelve un nombre entre `candidates` o a la propia orquestadora.
fn resolve_member<'a>(me: &'a OpenTab, candidates: &'a [OpenTab], name: &str) -> Result<&'a OpenTab, String> {
    if me.id == name || me.name.eq_ignore_ascii_case(name.trim()) {
        return Ok(me);
    }
    resolve_peer(candidates, name)
}

/// Le pide al frontend que cambie su canvas: es él quien lo tiene en memoria y lo guarda,
/// así que escribir el archivo desde acá se perdería con su próximo guardado.
fn canvas_change(app: &AppHandle, me: &OpenTab, command: &str, args: Value) -> Result<(), String> {
    let raw = ask_frontend(app, command, &args, Some(&me.window))?;
    unwrap_frontend_result(raw).map(|_| ())
}

pub(super) fn peer_connect(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = orchestrator(app, args)?;
    let candidates = operable(app, &me)?;
    let a = resolve_member(&me, &candidates, &arg_str(args, "a")?)?.clone();
    let b = resolve_member(&me, &candidates, &arg_str(args, "b")?)?.clone();
    if a.id == b.id {
        return Err("Não dá para conectar um agente com ele mesmo.".into());
    }
    canvas_change(app, &me, "canvas.connect", json!({ "cwd": me.cwd, "a": a.id, "b": b.id }))?;
    Ok(json!({ "connected": [describe(&a), describe(&b)] }))
}

pub(super) fn peer_disconnect(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = orchestrator(app, args)?;
    let candidates = operable(app, &me)?;
    let a = resolve_member(&me, &candidates, &arg_str(args, "a")?)?.clone();
    let b = resolve_member(&me, &candidates, &arg_str(args, "b")?)?.clone();
    canvas_change(app, &me, "canvas.disconnect", json!({ "cwd": me.cwd, "a": a.id, "b": b.id }))?;
    Ok(json!({ "disconnected": [describe(&a), describe(&b)] }))
}

/// Suma un agente al equipo: abre una tab en la carpeta de la orquestadora, la pone debajo
/// de ella en el canvas, la conecta y, si hay `--prompt`, le da la primera tarea.
///
/// La tarea va DESPUÉS de conectar: el agente nuevo tiene que poder contestar con
/// `ccode peer tell` desde su primer turno.
pub(super) fn peer_recruit(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = orchestrator(app, args)?;
    let name = arg_str(args, "name")?;
    let agent = arg_str(args, "agent")?;
    if name.trim().is_empty() {
        return Err("O agente novo precisa de um nome.".into());
    }
    let taken = open_tabs(app)?.into_iter().any(|t| t.cwd == me.cwd && t.name.eq_ignore_ascii_case(name.trim()));
    if taken {
        return Err(format!("Já existe um agente chamado '{name}' nesta pasta. Escolha outro nome."));
    }

    let mut create = json!({ "cwd": me.cwd, "agent": agent, "title": name, "window": me.window });
    if let Some(account) = arg_str_opt(args, "account") {
        create["account"] = json!(account);
    }
    let created = tab_create(app, &create)?;
    let tab_id = created.get("tabId").and_then(Value::as_str).ok_or("A aba foi criada sem id")?.to_string();

    canvas_change(app, &me, "canvas.recruited", json!({ "cwd": me.cwd, "tabId": tab_id, "near": me.id }))?;

    let mut out = json!({ "recruited": { "id": tab_id, "name": name, "agent": agent, "cwd": me.cwd } });
    if let Some(prompt) = arg_str_opt(args, "prompt").filter(|p| !p.trim().is_empty()) {
        let pty = wait_for_pty(app, &tab_id, Some(&me.window))?;
        let ready = wait_until_ready(pty);
        submit_prompt(pty, &framed(&me.name, &prompt, false))?;
        out["promptSent"] = json!(true);
        out["promptWaitedForReady"] = json!(ready);
    }
    Ok(out)
}

/// Lo que se ve en la terminal de una tab, leído del buffer de xterm (texto ya dibujado,
/// no la secuencia cruda de escapes). `from` = desde qué línea; sin él, la pantalla visible.
fn screen(app: &AppHandle, tab: &OpenTab, from: Option<u64>, max: u64) -> Result<Value, String> {
    let raw = ask_frontend(
        app,
        "tab.screen",
        &json!({ "tabId": tab.id, "from": from, "max": max }),
        Some(&tab.window),
    )?;
    unwrap_frontend_result(raw)
}

pub(super) fn peer_check(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let to = arg_str(args, "to")?;
    let (_, list) = peers(app, &from)?;
    let target = resolve_peer(&list, &to)?;
    let lines = arg_u64_opt(args, "lines").unwrap_or(60).clamp(1, 400);
    let shown = screen(app, target, None, lines)?;
    Ok(json!({ "peer": describe(target), "screen": shown.get("lines").cloned().unwrap_or(json!([])) }))
}

pub(super) fn peer_tell(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let to = arg_str(args, "to")?;
    let text = arg_str(args, "text")?;
    let (me, list) = peers(app, &from)?;
    let target = resolve_peer(&list, &to)?;
    let pty = pty_id_for_tab(app, &target.id, Some(&target.window))?;
    let from_name = me.map(|m| m.name).unwrap_or_else(|| from.clone());

    // No se interrumpe a quien está a mitad de un turno: se espera a que se calle un poco.
    wait_until_quiet(pty, Duration::from_millis(1500), Duration::from_secs(60), false);
    submit_prompt(pty, &framed(&from_name, &text, false))?;
    Ok(json!({ "peer": describe(target), "sent": true }))
}

/// Cuánto silencio marca el fin del turno de un agente. Las TUIs animan un spinner
/// mientras trabajan, así que unos segundos sin una sola escritura es que terminaron.
const TURN_QUIET: Duration = Duration::from_secs(5);
const DEFAULT_TIMEOUT_S: u64 = 600;

pub(super) fn peer_ask(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let to = arg_str(args, "to")?;
    let text = arg_str(args, "text")?;
    let timeout = Duration::from_secs(arg_u64_opt(args, "timeout").unwrap_or(DEFAULT_TIMEOUT_S).clamp(10, 3600));
    let (me, list) = peers(app, &from)?;
    let target = resolve_peer(&list, &to)?.clone();
    let pty = pty_id_for_tab(app, &target.id, Some(&target.window))?;
    let from_name = me.map(|m| m.name).unwrap_or_else(|| from.clone());

    wait_until_quiet(pty, Duration::from_millis(1500), Duration::from_secs(60), false);

    // La marca: desde qué línea de la terminal empieza la respuesta.
    let mark = screen(app, &target, None, 1)?.get("end").and_then(Value::as_u64);
    let before = crate::terminal::output_total(pty).unwrap_or(0);

    submit_prompt(pty, &framed(&from_name, &text, true))?;
    let finished = wait_turn(pty, before, timeout);

    let reply = screen(app, &target, mark, 200)?;
    Ok(json!({
        "peer": describe(&target),
        // `false` = se agotó el tiempo: lo que hay es parcial y el otro sigue trabajando.
        // Conviene `peer check` más tarde en vez de volver a preguntar.
        "finished": finished,
        "reply": reply.get("lines").cloned().unwrap_or(json!([])),
    }))
}

/// Espera a que el otro empiece a contestar y después a que termine.
fn wait_turn(pty: u32, before: u64, timeout: Duration) -> bool {
    const POLL: Duration = Duration::from_millis(200);
    let deadline = Instant::now() + timeout;
    let mut last = before;
    let mut quiet_since: Option<Instant> = None;
    let mut started = false;

    while Instant::now() < deadline {
        std::thread::sleep(POLL);
        let Some(total) = crate::terminal::output_total(pty) else { return false };
        if total != last {
            last = total;
            quiet_since = None;
            started = true;
            continue;
        }
        if !started {
            continue;
        }
        match quiet_since {
            Some(since) if since.elapsed() >= TURN_QUIET => return true,
            Some(_) => {}
            None => quiet_since = Some(Instant::now()),
        }
    }
    false
}

#[cfg(test)]
mod test {
    use super::*;

    fn tab(id: &str, name: &str) -> OpenTab {
        OpenTab { id: id.into(), name: name.into(), agent: "Claude Code".into(), cwd: "/p".into(), window: "main".into() }
    }

    #[test]
    fn resuelve_por_nombre_sin_mayusculas_y_por_id() {
        let peers = vec![tab("t1", "Revisor"), tab("t2", "Backend")];
        assert_eq!(resolve_peer(&peers, "revisor").unwrap().id, "t1");
        assert_eq!(resolve_peer(&peers, "t2").unwrap().id, "t2");
    }

    #[test]
    fn un_nombre_que_no_esta_conectado_lista_los_que_si() {
        let peers = vec![tab("t1", "Revisor")];
        let err = resolve_peer(&peers, "Frontend").unwrap_err();
        assert!(err.contains("Revisor"), "{err}");
    }

    #[test]
    fn sin_conexiones_explica_que_hay_que_ligarlos() {
        let err = resolve_peer(&[], "Frontend").unwrap_err();
        assert!(err.contains("canvas"), "{err}");
    }

    #[test]
    fn dos_con_el_mismo_nombre_piden_el_id() {
        let peers = vec![tab("t1", "Claude Code"), tab("t2", "Claude Code")];
        let err = resolve_peer(&peers, "claude code").unwrap_err();
        assert!(err.contains("t1") && err.contains("t2"), "{err}");
    }

    #[test]
    fn el_mensaje_dice_quien_lo_manda_y_como_contestar() {
        let ask = framed("Líder", "rodar os testes", true);
        assert!(ask.starts_with("[Mensagem de Líder via ADE AGS] rodar os testes"));
        let tell = framed("Líder", "pronto", false);
        assert!(tell.contains("ccode peer tell \"Líder\""));
    }
}
