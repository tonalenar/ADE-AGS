//! Comandos de tabs: listarlas, crearlas, leer su salida y escribirles.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::agents::{resolve_account_id, resolve_prelaunch_steps};
use super::shared::{bridge_call, db};
use crate::ipc::bridge::{ask_frontend, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt, arg_u64_checked};

/// Tabs de todas las ventanas ABIERTAS, con el id de PTY vivo si lo tienen. Las tabs de
/// ventanas cerradas (workspaces guardados) no se listan: para la CLI, "las tabs" son las
/// que están corriendo ahora.
pub(super) fn tab_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.agent_id, t.agent_label, t.command, t.cwd, t.session_id,
                    w.label, w.workspace_id, t.tab_order
             FROM tabs t JOIN windows w ON w.id = t.window_id
             WHERE w.is_open = 1
             ORDER BY w.label ASC, t.tab_order ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, Option<String>>(1)?,
                "agentId": r.get::<_, String>(2)?,
                "agentLabel": r.get::<_, String>(3)?,
                "command": r.get::<_, String>(4)?,
                "cwd": r.get::<_, String>(5)?,
                "sessionId": r.get::<_, Option<String>>(6)?,
                "window": r.get::<_, String>(7)?,
                "workspaceId": r.get::<_, String>(8)?,
                "order": r.get::<_, i64>(9)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(json!({ "tabs": rows }))
}

/// El id de PTY no está en SQLite (es efímero, vive en memoria mientras el proceso
/// corre), así que hay que pedírselo al frontend, que es quien lo tiene asociado a su tab.
///
/// `window` importa: cada ventana solo conoce SUS tabs. Sin pasarlo, una tab creada con
/// `--window` se buscaba siempre en la primera ventana y "no existía".
pub(super) fn pty_id_for_tab(app: &AppHandle, tab_id: &str, window: Option<&str>) -> Result<u32, String> {
    // Primeiro o próprio registro de PTYs do backend: ele já sabe a qual aba pertence cada processo
    // e não depende de a janela responder. Só se não estiver lá pergunta-se ao frontend (que é o
    // que vê as abas que o backend ainda não conhece). Antes TODO `peer tell` esperava a janela,
    // e uma janela ocupada derrubava a mensagem com timeout de 15 s.
    if let Some(pty) = crate::terminal::pty_for_tab(tab_id.to_string()) {
        return Ok(pty);
    }
    let raw = ask_frontend(app, "tab.ptyId", &json!({ "tabId": tab_id }), window)?;
    let value = unwrap_frontend_result(raw)?;
    value
        .get("ptyId")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or_else(|| format!("A tab {tab_id} não tem um processo em execução"))
}

/// Igual, pero esperando: una tab recién creada todavía no tiene PTY (lo abre el frontend
/// al montar la terminal, un par de ciclos después de responder "creada").
pub(super) fn wait_for_pty(app: &AppHandle, tab_id: &str, window: Option<&str>) -> Result<u32, String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
    const POLL: std::time::Duration = std::time::Duration::from_millis(200);

    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        if let Ok(pty_id) = pty_id_for_tab(app, tab_id, window) {
            return Ok(pty_id);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "A tab {tab_id} foi criada, mas o processo dela não iniciou em {}s",
                TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(POLL);
    }
}

/// Crea una tab y, si se pidió, le manda un prompt inicial ya confirmado.
///
/// Las dos cosas que hace además de delegar en el frontend:
///
/// 1. **Traduce nombres de skills a ids.** El usuario escribe `--skills git-helper`, pero
///    `attach_skill` necesita el id (un UUID). Se resuelve acá, que es donde está la base,
///    y así el error puede decir qué hay instalado en vez de fallar sin explicación.
/// 2. **Espera a que la TUI esté lista antes de escribirle.** Mandar el prompt apenas
///    aparece el PTY no funciona: los agentes tardan en levantar y descartan lo que llega
///    mientras tanto. Ver `wait_until_ready`.
pub(super) fn tab_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let window = arg_str_opt(args, "window");
    let prompt = init_prompt(args);

    // Los ids resueltos reemplazan a los nombres antes de cruzar el puente.
    let mut forwarded = args.clone();
    if let Some(requested) = skill_names(args) {
        let ids = resolve_skill_ids(app, &requested)?;
        forwarded["skills"] = json!(ids);
    }
    // `--account trabajo` → el id de esa cuenta. Se resuelve acá, contra la base, para
    // poder FALLAR con un motivo: una cuenta inexistente que se ignore en silencio abre la
    // tab con la cuenta equivocada, que es el peor resultado posible — parece que funcionó.
    if let Some(name) = arg_str_opt(args, "account") {
        let agent = arg_str_opt(args, "agent").unwrap_or_default();
        match crate::accounts::pools::pool_ref(&name) {
            // La del sistema (`None`) no lleva `accountId`: la tab se abre sin cuenta de la app.
            Some(pool) => {
                if let Some(id) = super::agents::resolve_pool_account(app, &agent, pool)? {
                    forwarded["accountId"] = json!(id);
                }
            }
            None => forwarded["accountId"] = json!(resolve_account_id(app, &agent, &name)?),
        }
    }
    // `--pre "..."` / `--pre-preset nombre` → la cadena ya con ids. Mismo criterio que con
    // las cuentas: un preset inexistente falla acá y no lanza la tab, porque arrancar sin
    // el entorno que se pidió es peor que no arrancar.
    if let Some(steps) = args.get("prelaunch").and_then(|v| v.as_array()) {
        forwarded["prelaunch"] = json!(resolve_prelaunch_steps(app, steps)?);
    }

    let created = bridge_call(app, "tab.create", &forwarded)?;

    let Some(prompt) = prompt else { return Ok(created) };
    let tab_id = created
        .get("tabId")
        .and_then(|v| v.as_str())
        .ok_or("A tab foi criada, mas não devolveu o id dela")?
        .to_string();

    let pty_id = wait_for_pty(app, &tab_id, window.as_deref())?;
    let ready = wait_until_ready(pty_id);
    submit_prompt(pty_id, &prompt)?;

    let mut out = created;
    out["promptSent"] = json!(true);
    // Si se agotó la espera igual se manda: es mejor que abandonar, pero el llamador tiene
    // que poder enterarse de que quizá la TUI no estaba escuchando todavía.
    out["promptWaitedForReady"] = json!(ready);
    Ok(out)
}

/// `--initprompt` y `--init-prompt` llegan como claves distintas (el parser de la CLI
/// pasa los guiones a camelCase). Se aceptan las dos: son el mismo flag para el usuario.
pub(crate) fn init_prompt(args: &Value) -> Option<String> {
    arg_str_opt(args, "initPrompt")
        .or_else(|| arg_str_opt(args, "initprompt"))
        .filter(|p| !p.trim().is_empty())
}

pub(crate) fn skill_names(args: &Value) -> Option<Vec<String>> {
    let raw = args.get("skills")?.as_array()?;
    let names: Vec<String> =
        raw.iter().filter_map(|v| v.as_str()).map(str::to_string).collect();
    (!names.is_empty()).then_some(names)
}

/// Nombre (o id) → id de skill instalada. Case-insensitive, porque escribir el nombre
/// exacto de memoria en una terminal es pedir demasiado.
/// Una skill instalada, con lo que hace falta para distinguirla de otra que se llame
/// igual: el nombre no alcanza (ver `match_one_skill`).
pub(crate) struct InstalledSkill {
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    pub registry_name: Option<String>,
}

fn resolve_skill_ids(app: &AppHandle, requested: &[String]) -> Result<Vec<String>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;

    let mut installed: Vec<InstalledSkill> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, author, registry_name FROM skills")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(InstalledSkill {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    author: r.get(2)?,
                    registry_name: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        installed.extend(rows.filter_map(|r| r.ok()));
    }

    match_skill_ids(&installed, requested)
}

/// El emparejamiento en sí, sobre `(id, name)` ya leídos. Separado para poder probarlo.
pub(crate) fn match_skill_ids(
    installed: &[InstalledSkill],
    requested: &[String],
) -> Result<Vec<String>, String> {
    requested.iter().map(|wanted| match_one_skill(installed, wanted)).collect()
}

/// Resuelve UN nombre (o id) a un id instalado.
///
/// Un nombre que corresponde a varias skills es un ERROR, no una elección al azar: dos
/// skills homónimas pueden ser de autores distintos y hacer cosas distintas, así que
/// quedarse con la primera que devuelva SQLite le montaría a la tab una que el usuario no
/// pidió — en silencio. El error dice cuáles son y cómo desambiguar (por id).
fn match_one_skill(installed: &[InstalledSkill], wanted: &str) -> Result<String, String> {
    let needle = wanted.to_lowercase();

    // El id es único por definición: si coincide, no hay nada que desambiguar.
    if let Some(s) = installed.iter().find(|s| s.id.to_lowercase() == needle) {
        return Ok(s.id.clone());
    }

    let matches: Vec<&InstalledSkill> =
        installed.iter().filter(|s| s.name.to_lowercase() == needle).collect();

    match matches.as_slice() {
        [only] => Ok(only.id.clone()),
        [] => {
            let names: Vec<&str> = installed.iter().map(|s| s.name.as_str()).collect();
            if names.is_empty() {
                Err(format!("Não há nenhuma skill instalada, então '{wanted}' não existe. Instale uma com 'ags skill install --skill <nome>'"))
            } else {
                Err(format!("Não há nenhuma skill instalada chamada '{wanted}'. Instaladas: {}", names.join(", ")))
            }
        }
        varias => {
            let detalle: Vec<String> = varias
                .iter()
                .map(|s| {
                    let origen = match (&s.author, &s.registry_name) {
                        (Some(a), Some(r)) => format!("{a}, {r}"),
                        (Some(a), None) => a.clone(),
                        (None, Some(r)) => r.clone(),
                        (None, None) => "instalada a mano".to_string(),
                    };
                    format!("{} ({origen})", s.id)
                })
                .collect();
            Err(format!(
                "Há {} skills instaladas chamadas '{wanted}' e não são a mesma. Use o id: {}",
                varias.len(),
                detalle.join(" · ")
            ))
        }
    }
}

/// Espera a que la TUI deje de escribir por `quiet`, hasta un máximo de `max`.
///
/// No hay forma portable de preguntarle a un proceso "¿ya estás listo?", y una espera fija
/// o se queda corta con un agente lento o desperdicia segundos con uno rápido. El silencio
/// es la mejor señal disponible: es la misma idea que el evento `idle` del modo push.
///
/// `require_output` distingue los dos usos: al arrancar, "todavía no escribió nada" NO es
/// silencio, es que no arrancó; después de escribirle un prompt, una TUI que no repinta
/// nada sí cuenta como quieta.
///
/// Devuelve `false` si se agotó el tiempo (o si el proceso murió).
pub(super) fn wait_until_quiet(
    pty_id: u32,
    quiet: std::time::Duration,
    max: std::time::Duration,
    require_output: bool,
) -> bool {
    const POLL: std::time::Duration = std::time::Duration::from_millis(100);

    let deadline = std::time::Instant::now() + max;
    let mut last_total = crate::terminal::output_total(pty_id).unwrap_or(0);
    let mut quiet_since: Option<std::time::Instant> = None;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(POLL);
        let Some(total) = crate::terminal::output_total(pty_id) else {
            return false;
        };

        if total != last_total {
            last_total = total;
            quiet_since = None;
            continue;
        }
        if require_output && total == 0 {
            continue;
        }
        match quiet_since {
            Some(since) if since.elapsed() >= quiet => return true,
            Some(_) => {}
            None => quiet_since = Some(std::time::Instant::now()),
        }
    }
    false
}

/// Espera a que la TUI termine de arrancar.
pub(super) fn wait_until_ready(pty_id: u32) -> bool {
    wait_until_quiet(
        pty_id,
        std::time::Duration::from_millis(700),
        std::time::Duration::from_secs(25),
        true,
    )
}

/// Escribe un prompt en una TUI y lo confirma con Enter.
///
/// **El Enter va en una escritura aparte, y después de que la TUI se aquietó.** Mandarlo
/// pegado al texto (`"{prompt}\r"`, que es lo que se hacía antes) no envía nada: los
/// agentes con caja de texto multilínea reciben todo en el mismo chunk del PTY y tratan
/// ese CR como un salto de línea DENTRO del prompt, no como "enviar". El prompt queda
/// escrito y ahí se queda.
///
/// Separarlo reproduce lo que hace una persona: escribir, ver el texto aparecer, y recién
/// entonces apretar Enter. El silencio entre medio es lo que garantiza que llegue en una
/// lectura distinta, incluso si la TUI tarda en repintar.
pub(super) fn submit_prompt(pty_id: u32, text: &str) -> Result<(), String> {
    submit_prompt_seen(pty_id, text).map(|_| ())
}

/// O mesmo que `submit_prompt`; `true` se a TUI mostrou que começou a trabalhar depois do Enter (a prova
/// mais firme de que a mensagem foi enviada).
pub(super) fn submit_prompt_seen(pty_id: u32, text: &str) -> Result<bool, String> {
    const ECHO_QUIET: std::time::Duration = std::time::Duration::from_millis(250);
    const ECHO_MAX: std::time::Duration = std::time::Duration::from_secs(5);

    crate::terminal::write_to_pty(pty_id, text)?;
    wait_until_quiet(pty_id, ECHO_QUIET, ECHO_MAX, false);
    // Uma TUI que ainda carregava (o OpenCode na tela inicial) joga fora o que chega: o texto nem aparece, e
    // não há o que enviar. Espera ela assentar e escreve de novo — só se NENHUM pedaço dele está na tela, para
    // nunca duplicar a mensagem. No máximo duas vezes.
    for _ in 0..2 {
        if text_on_screen(pty_id, text) {
            break;
        }
        wait_until_quiet(pty_id, std::time::Duration::from_millis(700), std::time::Duration::from_secs(10), false);
        if text_on_screen(pty_id, text) {
            break;
        }
        crate::terminal::write_to_pty(pty_id, text)?;
        wait_until_quiet(pty_id, ECHO_QUIET, ECHO_MAX, false);
    }
    crate::terminal::write_to_pty(pty_id, "\r")?;
    // Um pegado grande vira "[Pasted Content 3904 chars]" e pode engolir o Enter: a mensagem
    // fica escrita e ninguém a recebe. O Hermes e o OpenCode não usam o marcador: o texto fica
    // inteiro na caixa (e, ainda "starting agent…", eles engolem o Enter). Enquanto a TUI não mostra
    // que está trabalhando ("esc to interrupt") e o marcador ou a mensagem segue na tela, manda outro
    // — no máximo quatro vezes (Enter numa caixa vazia não faz nada).
    //
    // "Saiu muita coisa depois do Enter" só vale se for texto NOVO e variado: o OpenCode anima o título
    // sem parar (o mesmo punhado de palavras, quadro a quadro), e essa saída dava o Enter engolido por
    // enviado — a mensagem do orquestrador ficava na caixa até a pessoa apertar Enter. A animação também
    // empurra a caixa para fora do fim curto da saída, por isso a mensagem é procurada num trecho maior.
    for _ in 0..4 {
        let before = crate::terminal::output_total(pty_id).unwrap_or(0);
        wait_until_quiet(pty_id, std::time::Duration::from_millis(400), std::time::Duration::from_secs(4), false);
        let wrote = crate::terminal::output_total(pty_id).unwrap_or(0).saturating_sub(before) as usize;
        if tui_working(pty_id) {
            return Ok(true);
        }
        let fresh = crate::terminal::tail_of(pty_id, wrote.min(65_536))
            .is_some_and(|raw| varied_text(&crate::orchestrator::digest::strip_ansi(&raw)));
        if fresh || !paste_still_pending(pty_id, text) {
            break;
        }
        crate::terminal::write_to_pty(pty_id, "\r")?;
    }
    Ok(tui_working(pty_id))
}

/// O fim da tela mostra que o agente está trabalhando agora?
fn tui_working(pty_id: u32) -> bool {
    crate::terminal::tail_of(pty_id, 4096)
        .is_some_and(|raw| working_in(&crate::orchestrator::digest::strip_ansi(&raw)))
}

/// Pura: o trecho tem texto de verdade (mais de 12 palavras diferentes), e não só uma animação que
/// repinta as mesmas poucas palavras.
pub(super) fn varied_text(chunk: &str) -> bool {
    chunk.split_whitespace().collect::<std::collections::HashSet<_>>().len() > 12
}

/// Pura: o rodapé de trabalho das TUIs — "esc to interrupt" (Claude, Codex), "esc interrupt" (OpenCode).
pub(super) fn working_in(screen: &str) -> bool {
    let lower = screen.to_lowercase();
    lower.contains("esc to interrupt") || lower.contains("esc interrupt")
}

/// O fim da saída do PTY ainda mostra o colado na caixa de entrada (o marcador, ou o texto inteiro)?
fn paste_still_pending(pty_id: u32, message: &str) -> bool {
    let Some(text) = crate::terminal::tail_of(pty_id, 32_768) else { return false };
    let screen = crate::orchestrator::digest::strip_ansi(&text);
    pending_paste_in(&screen) || typed_text_in(&screen, message)
}

/// O texto escrito apareceu na tela (o começo ou o fim dele)? Sem isso a TUI o descartou.
fn text_on_screen(pty_id: u32, message: &str) -> bool {
    let Some(raw) = crate::terminal::tail_of(pty_id, 32_768) else { return true };
    text_shown_in(&crate::orchestrator::digest::strip_ansi(&raw), message)
}

/// Pura: o começo ou o fim da mensagem (16 caracteres que contam) está na tela, ou o marcador com que o
/// Claude e o Codex trocam um colado grande ("[Pasted text #1 +30 lines]"): na dúvida, conta como escrito.
pub(super) fn text_shown_in(screen: &str, message: &str) -> bool {
    let sent: Vec<char> = without_layout(message).chars().collect();
    if sent.is_empty() || screen.contains("[Pasted") {
        return true;
    }
    let head: String = sent[..sent.len().min(16)].iter().collect();
    let shown = without_layout(screen);
    shown.contains(&head) || typed_text_in(screen, message)
}

/// Espaços e bordas de caixa: o mesmo texto quebrado em linhas dentro de uma caixa ainda é o mesmo texto.
fn without_layout(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace() && !matches!(c, '│' | '┃' | '║' | '|' | '▌' | '▐')).collect()
}

/// Pura: o fim da mensagem (os últimos 16 caracteres que contam) aparece no fim da tela. Só vale junto
/// com "quase nada saiu depois do Enter": depois de um envio que pegou, a TUI repinta muito mais que isso.
pub(super) fn typed_text_in(screen: &str, message: &str) -> bool {
    let sent: Vec<char> = without_layout(message).chars().collect();
    if sent.is_empty() {
        return false;
    }
    let tail: String = sent[sent.len().saturating_sub(16)..].iter().collect();
    without_layout(screen).contains(&tail)
}

/// Pura: nas últimas linhas com texto, uma linha de prompt (>, ›, ❯) com o marcador de pegado.
pub(super) fn pending_paste_in(screen: &str) -> bool {
    screen
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(6)
        .any(|line| {
            let trimmed = line.trim_start();
            (trimmed.starts_with('>') || trimmed.starts_with('›') || trimmed.starts_with('❯'))
                && (line.contains("[Pasted Content") || line.contains("[Pasted text"))
        })
}

#[cfg(test)]
mod paste_tests {
    use super::{pending_paste_in, text_shown_in, typed_text_in, varied_text, working_in};

    #[test]
    fn animacao_do_titulo_nao_conta_como_saida_nova() {
        let frames = "   Teste de resposta AZUL       ".repeat(40);
        assert!(!varied_text(&frames));
        let listing: String = (1..=30).map(|n| format!("linha {n} ....
")).collect();
        assert!(varied_text(&listing));
    }

    #[test]
    fn rodape_de_trabalho_conta_como_enviado() {
        assert!(working_in("■■⬝⬝⬝⬝⬝⬝ esc interrupt"));
        assert!(working_in("✻ Thinking… (3s · esc to interrupt)"));
        assert!(!working_in("Build · Claude Haiku 5.5 · 2.3s   ctrl+p commands"));
    }

    #[test]
    fn texto_descartado_pela_tui_nao_conta_como_escrito() {
        let sent = "Responda apenas com a palavra CANELA, sem usar ferramentas.";
        // OpenCode ainda na tela inicial: só o logo e o aviso de atualização.
        assert!(!text_shown_in("▀▀▀▀ ▀▀▀▀\n/update to install v2.0.32", sent));
        // Apareceu (inteiro, ou só o começo numa caixa estreita): não escreve de novo.
        assert!(text_shown_in("┃ Responda apenas com a palavra CANELA, sem usar ferramentas.", sent));
        assert!(text_shown_in("┃ Responda apenas com a pa", sent));
        assert!(text_shown_in("qualquer", "  "));
        // O marcador de colado grande do Claude/Codex: o texto está lá, só escondido. Nada de colar de novo.
        assert!(text_shown_in("│ > [Pasted text #1 +30 lines]   │", sent));
    }

    #[test]
    fn o_texto_inteiro_na_caixa_conta_como_nao_enviado() {
        // Hermes: o texto quebrado em linhas, com a barra de status depois.
        let screen = "❯ [ADE AGS] Você é um subagente deste time. O orquestrador vai definir o seu papel e enviar as\n tarefas: aguarde.\n[OMH] v2.0.3 | [global] ready";
        let sent = "[ADE AGS] Você é um subagente deste time. O orquestrador vai definir o seu papel e enviar as tarefas: aguarde.";
        assert!(typed_text_in(screen, sent));
        assert!(!typed_text_in("> outra coisa\n", sent));
        assert!(!typed_text_in("qualquer", "   "));
    }

    #[test]
    fn marker_on_the_prompt_line_is_pending_and_in_history_is_not() {
        assert!(pending_paste_in("trabalho\n> [Pasted Content 3904 chars]\n"));
        assert!(pending_paste_in("› [Pasted text #1 +30 lines]"));
        assert!(!pending_paste_in("> pergunta enviada\n⏺ resposta"));
        assert!(!pending_paste_in("  [Pasted text #1 +30 lines] (histórico)\n> "));
    }
}


/// Cuántas líneas de cola devuelve `tab output` por defecto. Antes eran 200 líneas crudas;
/// con la salida ya comprimida, 40 líneas útiles dicen más y cuestan una fracción.
const DEFAULT_TAIL_LINES: usize = 40;

/// Salida de una tab, comprimida para que la lea un modelo (Fase 9).
///
/// Dos cosas la diferencian de devolver el scrollback:
///
/// 1. **Solo lo nuevo.** Cada llamada arranca donde terminó la anterior. Releer una tab
///    que no escribió nada devuelve vacío en vez de reenviar las mismas 200 líneas — que
///    era la forma más fácil de agotar el contexto sin enterarse.
/// 2. **Señales, no transcripción.** Errores y warnings se extraen del texto COMPLETO
///    (aunque hayan quedado fuera de la cola) y el resto se colapsa (ver `orchestrator::digest`).
///
/// Escotillas: `--full` ignora el cursor y digiere todo el scrollback vivo; `--raw`
/// devuelve las últimas `--lines` líneas sin comprimir, para cuando el modelo necesita ver
/// el texto exacto.
pub(super) fn tab_output(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use crate::orchestrator::digest;

    let tab_id = arg_str(args, "tab")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;

    let (scrollback, total_bytes) = crate::terminal::scrollback_of(pty_id)
        .ok_or_else(|| format!("La tab {tab_id} no tiene salida disponible"))?;

    let full = args.get("full").and_then(|v| v.as_bool()).unwrap_or(false);
    let raw_mode = args.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
    let tail_lines = arg_u64_checked(args, "lines")?.unwrap_or(DEFAULT_TAIL_LINES as u64) as usize;

    if raw_mode {
        // El crudo no mueve el cursor: es una inspección puntual, no "leer lo nuevo".
        let all: Vec<&str> = scrollback.lines().collect();
        let start = all.len().saturating_sub(tail_lines);
        return Ok(json!({
            "tabId": tab_id,
            "mode": "raw",
            "lines": all[start..],
            "truncated": start > 0,
            "totalLines": all.len(),
        }));
    }

    let (text, scope, lost) = if full {
        // `--full` deja igual el cursor puesto al día, para que la siguiente llamada
        // vuelva a devolver solo lo nuevo.
        let out = crate::orchestrator::new_output_for(&tab_id, &scrollback, total_bytes);
        (scrollback.clone(), "full", out.lost)
    } else {
        let out = crate::orchestrator::new_output_for(&tab_id, &scrollback, total_bytes);
        let scope = if out.first_read { "full" } else { "new" };
        (out.text, scope, out.lost)
    };

    let d = digest::digest(&text, tail_lines);

    Ok(json!({
        "tabId": tab_id,
        "mode": "digest",
        // `new` = solo lo que llegó desde la lectura anterior; `full` = todo el scrollback
        // vivo (primera lectura de esta tab, o `--full`).
        "scope": scope,
        "errors": d.errors,
        "warnings": d.warnings,
        "tail": d.tail,
        // `true` si parte de la salida se perdió: el proceso escribió más de lo que cabe
        // en el scrollback y lo más viejo ya no existe.
        "lost": lost,
        "truncated": d.kept_lines > d.tail.len(),
        "summary": {
            "rawLines": d.raw_lines,
            "keptLines": d.kept_lines,
            "estimatedTokens": digest::estimate_tokens(&d.tail.concat()),
        },
    }))
}


pub(super) fn tab_send(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let text = arg_str(args, "text")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;

    // Por defecto se manda Enter al final: "send" en una TUI interactiva casi siempre
    // significa "escribí esto y confirmá". `--no-enter` sirve para mandar teclas sueltas
    // (Escape, Ctrl-C) o para dejar el prompt escrito sin enviarlo, y ahí el texto va
    // crudo: separar el Enter no aplica porque no hay Enter.
    if args.get("noEnter").and_then(|v| v.as_bool()).unwrap_or(false) {
        crate::terminal::write_to_pty(pty_id, &text)?;
    } else {
        submit_prompt(pty_id, &text)?;
        let _ = app.emit("cc-peer-message", json!({ "kind": "ask",
            "fromTabId": arg_str_opt(args, "from").unwrap_or_default(), "toTabId": tab_id,
            "atMs": crate::util::now_ts_ms() }));
    }

    Ok(json!({ "tabId": tab_id, "sent": true }))
}
