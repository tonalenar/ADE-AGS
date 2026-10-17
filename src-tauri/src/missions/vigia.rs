//! O Vigia em segundo plano: um modelo barato, sem terminal, que decide se alguém da equipe
//! está ocioso e o que dizer.
//!
//! O app (de graça) detecta quem está sem saída há um tempo e só então chama isto. Aqui se lê o
//! fim da tela de cada suspeito e do Orquestrador, roda-se UMA chamada headless do modelo barato
//! (`claude -p --model haiku` ou `codex exec -m gpt-6-luna`) e devolvem-se as mensagens a
//! entregar. Nenhum processo fica vivo depois: nada de terminal aberto gastando memória.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Quanto se espera pela resposta do modelo.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Quanto da tela de cada um vai para o modelo (fim da saída, sem ANSI).
const SCREEN_LINES: usize = 40;
const SCREEN_CHARS: usize = 2_500;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VigiaTab {
    pub tab_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VigiaAction {
    /// Nome de quem recebe (o Orquestrador ou um integrante), ou `usuario`.
    pub to: String,
    pub message: String,
}

/// O fim da tela de uma aba, legível. Vazio se a aba não tem terminal vivo.
fn screen_tail(tab_id: &str) -> String {
    let Some(pty) = crate::terminal::pty_for_tab(tab_id.to_string()) else { return String::new() };
    let Some((text, _)) = crate::terminal::scrollback_of(pty) else { return String::new() };
    let start = text.len().saturating_sub(SCREEN_CHARS * 4);
    let start = (start..=text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(text.len());
    tail_lines(&crate::orchestrator::digest::strip_ansi(&text[start..]))
}

/// As últimas linhas com texto, até o limite de caracteres. Pura.
pub(crate) fn tail_lines(screen: &str) -> String {
    let lines: Vec<&str> = screen.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let mut out: Vec<&str> = lines.iter().rev().take(SCREEN_LINES).copied().collect();
    out.reverse();
    let joined = out.join("\n");
    if joined.chars().count() <= SCREEN_CHARS {
        return joined;
    }
    let skip = joined.chars().count() - SCREEN_CHARS;
    joined.chars().skip(skip).collect()
}

/// O pedido ao modelo barato. Pura.
pub(crate) fn prompt(mission_title: &str, lead: &str, screens: &[(String, String)]) -> String {
    let mut text = format!(
        "Você é o VIGIA da missão \"{mission_title}\" num app que coordena agentes de código. Você só OBSERVA.\n\
Abaixo está o fim da tela de agentes que estão sem escrever nada há mais de 90 s, e a do Orquestrador \"{lead}\".\n\
Decida, para cada um, se está OCIOSO de fato: esperando tarefa; terminou e não reportou; esperando resposta de alguém; \
travado num erro; ou esperando aprovação/pergunta do usuário. \
Quem está trabalhando (pensando, rodando build/teste longo) NÃO é ocioso.\n\
IGNORE a caixa de digitação do prompt (a linha depois de \">\" ou do cursor) e qualquer sugestão em cinza: \
é rascunho do usuário ou sugestão da própria ferramenta, nunca é motivo para agir nem para citar.\n\n"
    );
    for (name, screen) in screens {
        text.push_str(&format!("=== TELA DE \"{name}\" ===\n{}\n\n", if screen.is_empty() { "(vazia)" } else { screen }));
    }
    text.push_str(&format!(
        "Responda SÓ com um array JSON, sem texto antes ou depois. Cada item: {{\"to\": \"<nome>\", \"message\": \"<curta, em português>\"}}.\n\
- Ocioso esperando tarefa, esperando resposta ou travado: to = \"{lead}\", dizendo quem, a situação e o próximo passo sugerido.\n\
- O próprio Orquestrador ocioso com a equipe esperando: to = \"{lead}\".\n\
- Terminou e não reportou: to = o nome do próprio agente, pedindo para reportar ao Orquestrador.\n\
- Esperando o usuário: to = \"usuario\".\n\
Ninguém ocioso de fato: responda []. No máximo 3 itens. Nunca invente tarefas."
    ));
    text
}

/// O array JSON da resposta, mesmo com texto em volta; só destinatários conhecidos. Pura.
pub(crate) fn parse_actions(output: &str, known: &[String]) -> Vec<VigiaAction> {
    let (Some(start), Some(end)) = (output.find('['), output.rfind(']')) else { return Vec::new() };
    if end < start {
        return Vec::new();
    }
    let Ok(actions) = serde_json::from_str::<Vec<VigiaAction>>(&output[start..=end]) else { return Vec::new() };
    actions
        .into_iter()
        .filter(|a| !a.message.trim().is_empty() && (a.to == "usuario" || known.iter().any(|k| k == &a.to)))
        .take(3)
        .collect()
}

/// Uma chamada headless ao modelo barato. Devolve o texto da resposta.
fn call_model(agent_id: &str, model: &str, effort: &str, cwd: &str, prompt: &str) -> Result<String, String> {
    let (program, args, last_message) = match agent_id {
        "codex" => {
            let file = std::env::temp_dir().join(format!("ags-vigia-{}-{}.txt", std::process::id(), crate::util::now_ts_ms()));
            let args = vec![
                "exec".to_string(),
                "--skip-git-repo-check".into(),
                "--sandbox".into(),
                "read-only".into(),
                "-m".into(),
                model.into(),
                "-c".into(),
                format!("model_reasoning_effort=\"{effort}\""),
                "--output-last-message".into(),
                file.to_string_lossy().into_owned(),
                prompt.into(),
            ];
            ("codex", args, Some(file))
        }
        _ => {
            let args = vec![
                "-p".to_string(),
                prompt.into(),
                "--model".into(),
                model.into(),
                "--effort".into(),
                effort.into(),
                "--output-format".into(),
                "text".into(),
            ];
            ("claude", args, None)
        }
    };
    let path = crate::util::find_program(program).ok_or_else(|| format!("'{program}' não está instalado"))?;
    let mut cmd = crate::util::external_command(&path, &args).map_err(|e| e.to_string())?;
    cmd.current_dir(cwd);
    let out = crate::util::spawn::output(&mut cmd, CALL_TIMEOUT).map_err(|e| e.to_string())?;
    let text = match &last_message {
        Some(file) => std::fs::read_to_string(file).unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).into_owned()),
        None => String::from_utf8_lossy(&out.stdout).into_owned(),
    };
    if let Some(file) = last_message {
        let _ = std::fs::remove_file(file);
    }
    if !out.status.success() && text.trim().is_empty() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(300).collect());
    }
    Ok(text)
}

/// Um ciclo do Vigia: lê as telas, consulta o modelo barato e devolve o que entregar.
#[tauri::command]
pub async fn vigia_check(
    agent_id: String,
    model: String,
    effort: String,
    mission_title: String,
    cwd: String,
    lead: VigiaTab,
    idle: Vec<VigiaTab>,
) -> Result<Vec<VigiaAction>, String> {
    tokio::task::spawn_blocking(move || {
        let mut screens: Vec<(String, String)> = idle.iter().map(|t| (t.name.clone(), screen_tail(&t.tab_id))).collect();
        if !idle.iter().any(|t| t.tab_id == lead.tab_id) {
            screens.push((lead.name.clone(), screen_tail(&lead.tab_id)));
        }
        let text = prompt(&mission_title, &lead.name, &screens);
        let output = call_model(&agent_id, &model, &effort, &cwd, &text)?;
        let known: Vec<String> = screens.iter().map(|(name, _)| name.clone()).collect();
        Ok(parse_actions(&output, &known))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Escreve no chat do Orquestrador o que travou e o que foi feito: é ali que o usuário lê, não num
/// toast que some. Sai como resposta do agente e SEM aviso do sistema: é registro, não pedido de
/// atenção (o `ags say` é que pede atenção).
#[tauri::command]
pub fn vigia_report(app: AppHandle, tab_id: String, text: String) -> Result<(), String> {
    let text = crate::chat::clean_text(&text)?;
    let now = crate::util::now_ts();
    crate::chat::update(&tab_id, |conv| {
        let thread = crate::chat::reply_thread(conv, None)?;
        crate::chat::push(conv, thread, crate::chat::Kind::Say, text.clone(), now);
        Ok(())
    })?;
    let _ = app.emit(crate::ipc::commands::chat::CHANGED_EVENT, &tab_id);
    let boards = crate::canvas::load_boards();
    let db = app.state::<crate::database::DbConnection>();
    let conn = db.lock().map_err(|e| e.to_string())?;
    let name: String = conn.query_row(
        "SELECT COALESCE(NULLIF(title, ''), agent_label) FROM tabs WHERE id=?1",
        [&tab_id], |r| r.get(0),
    ).unwrap_or_else(|_| tab_id.clone());
    crate::missions::messages::record_vigia(&conn, &boards, (&tab_id, &name), &text, now * 1000)?;
    Ok(())
}

/// O título e o texto do aviso do sistema de uma missão que pede o usuário. Pura.
pub(crate) fn user_notice(kind: &str, mission_title: &str, body: &str) -> Option<(String, String)> {
    let title = mission_title.trim();
    let title = if title.is_empty() { "Missão" } else { title };
    match kind {
        "team_delivered" => Some((
            format!("Equipe entregou — {title}"),
            "Todos reportaram e estão parados. Revise e finalize a missão em Missões.".into(),
        )),
        "user_decision" => Some((format!("Decisão pendente — {title}"), crate::chat::preview(body, 180))),
        _ => None,
    }
}

/// O Vigia achou algo que só o usuário resolve: a equipe entregou (falta Finalizar) ou há uma
/// decisão dele pendente. Antes isso ia só para o chat, sem aviso do sistema, e a missão ficava horas
/// parada (no banco real, 21% do relógio das missões era espera depois da entrega e 44% espera por
/// decisões no meio). Agora sai também o aviso do sistema (com as regras do notificador: desligável e
/// só com a app sem foco) e, na entrega, o span `team_delivered`, que separa no tempo da missão o
/// trabalho da equipe da espera pelo clique. Devolve se o aviso do sistema apareceu.
#[tauri::command]
pub fn vigia_notify_user(app: AppHandle, mission_id: Option<String>, mission_title: String, kind: String, body: Option<String>) -> Result<bool, String> {
    let Some((title, text)) = user_notice(&kind, &mission_title, body.as_deref().unwrap_or("")) else {
        return Err(format!("Aviso desconhecido '{kind}'."));
    };
    if kind == "team_delivered" {
        if let Some(mission_id) = mission_id.as_deref().filter(|id| !id.starts_with("c:")) {
            let now = crate::util::now_ts() * 1000;
            let db = app.state::<crate::database::DbConnection>();
            let conn = db.lock().map_err(|e| e.to_string())?;
            let span = super::timings::NewSpan {
                kind: "team_delivered".into(),
                actor: "Vigia".into(),
                target: String::new(),
                started_ms: now,
                ended_ms: now,
                detail: String::new(),
            };
            super::timings::add(&conn, mission_id, &span)?;
        }
    }
    Ok(crate::notifier::show_custom(&app, &title, &text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn o_aviso_ao_usuario_diz_o_que_falta_e_recusa_tipos_desconhecidos() {
        let (title, body) = user_notice("team_delivered", "Site CredPro", "").unwrap();
        assert!(title.contains("Equipe entregou") && title.contains("Site CredPro"));
        assert!(body.contains("finalize"));
        let (title, body) = user_notice("user_decision", " ", "Posso abrir o PR?").unwrap();
        assert!(title.contains("Decisão pendente — Missão"));
        assert_eq!(body, "Posso abrir o PR?");
        assert!(user_notice("outro", "x", "").is_none());
    }

    #[test]
    fn so_aceita_o_json_e_destinatarios_conhecidos() {
        let known = vec!["Orquestrador".to_string(), "Backend".to_string()];
        let out = "Claro! [{\"to\":\"Orquestrador\",\"message\":\"Backend terminou e espera tarefa\"},{\"to\":\"Fulano\",\"message\":\"x\"},{\"to\":\"usuario\",\"message\":\"QA espera aprovação\"}] fim";
        let actions = parse_actions(out, &known);
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].to, "Orquestrador");
        assert_eq!(actions[1].to, "usuario");
        assert!(parse_actions("[]", &known).is_empty());
        assert!(parse_actions("sem json", &known).is_empty());
    }

    #[test]
    fn a_tela_vai_curta_e_o_pedido_cita_todos() {
        let screen = (0..100).map(|i| format!("linha {i}")).collect::<Vec<_>>().join("\n\n");
        let tail = tail_lines(&screen);
        assert!(tail.ends_with("linha 99") && !tail.contains("linha 10\n"));
        let text = prompt("M", "Orquestrador", &[("Backend".into(), "ok".into())]);
        assert!(text.contains("TELA DE \"Backend\"") && text.contains("array JSON") && text.contains("\"Orquestrador\""));
    }
}
