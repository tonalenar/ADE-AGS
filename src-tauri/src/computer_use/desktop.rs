//! Driver do computer use do Mac: o agente comanda a tela do usuário (`ags desk act`).
//!
//! Foto da tela principal (`screencapture`), OCR local (Vision) e entrada por CGEvent, tudo por
//! processos locais. Diferente do iOS, não há cartão no canvas para autorizar: a autorização é a pergunta
//! **no início de cada act** (nunca um interruptor, nunca flag), mais a confirmação por ação do núcleo.
//! Cada pergunta e cada resposta vão para a auditoria comum (`approval_audit`, `asked`/`decided`).
use super::ios::{
    Frame, VisualDecider, mark_key, marked_key, ocr, prepare_photo, private_screen,
};
use super::*;
use crate::{
    approval_audit::{self, Outcome, Source},
    database::DbConnection,
    decisions::vision::computer,
    ipc::bridge::{ask_frontend_within, unwrap_frontend_result},
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::AppHandle;

const PRIVATE_KEY: &str = "computer_use.desktop.private";
const GRANT: &str = "Autorizar este objetivo";
const ALLOW: &str = "Autorizar esta ação";
const DENY: &str = "Recusar";
const INPUT: &str = include_str!("desk_input.swift");

fn busy() -> &'static Mutex<bool> {
    static S: OnceLock<Mutex<bool>> = OnceLock::new();
    S.get_or_init(Default::default)
}
struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut b) = busy().lock() {
            *b = false;
        }
    }
}

pub(crate) struct Caller {
    pub tab: String,
    pub session: Option<String>,
    pub client_pid: Option<u32>,
}

/// Executa o script de entrada local. Nunca devolve stdout/stderr ao agente.
fn input(args: &[&str], deadline: Instant) -> Result<std::process::Output, String> {
    if Instant::now() >= deadline {
        return Err("Prazo esgotado.".into());
    }
    let mut cmd = crate::util::spawn::hidden_command("/usr/bin/swift");
    cmd.arg("-e").arg(INPUT).args(args);
    crate::util::spawn::output(
        &mut cmd,
        deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(60)),
    )
    .map_err(|_| "Entrada local indisponível.".to_string())
}

/// `x y largura altura` em pontos, como o script imprime.
pub(crate) fn parse_bounds(text: &str) -> Option<(f64, f64)> {
    let n: Vec<f64> = text
        .split_whitespace()
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    (n.len() == 4 && n[2].is_finite() && n[3].is_finite() && n[2] > 0. && n[3] > 0.)
        .then(|| (n[2], n[3]))
}
/// A roda do mouse: `scroll_up` revela o que está abaixo, como no iOS (dedo para cima).
pub(crate) fn scroll_delta(target: Option<&str>) -> i32 {
    if target == Some("scroll_up") { -400 } else { 400 }
}
/// Ponto normalizado da foto para pontos da tela. Fora de [0,1] não existe.
pub(crate) fn to_points(point: (f64, f64), width: f64, height: f64) -> Option<(f64, f64)> {
    let (x, y) = point;
    ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((x * width, y * height))
}
pub(crate) fn consent_question(goal: &str, steps: usize) -> String {
    let goal: String = goal.chars().filter(|c| !c.is_control()).take(300).collect();
    format!(
        "Um agente quer controlar o seu Mac (cliques, rolagem e, só com texto fornecido por ele, digitação) para: «{goal}».\n\
         A tela principal será fotografada e enviada ao provedor de Decisões configurado, depois que o OCR local não achar senha, cartão ou token. Até {steps} passos; ações sensíveis ou incertas pedirão confirmação uma a uma. Você pode recusar qualquer passo."
    )
}

/// Pergunta à pessoa e audita: `asked` antes, `decided` depois. Falha do registro não muda a resposta.
fn ask_audited(
    app: &AppHandle,
    db: &DbConnection,
    from: &str,
    tool: &str,
    question: &str,
    options: [&str; 2],
    allow: &str,
    deadline: Instant,
    review: Option<Value>,
) -> Result<bool, String> {
    let seconds = deadline
        .saturating_duration_since(Instant::now())
        .as_secs()
        .min(1800);
    let call = uuid::Uuid::new_v4().to_string();
    audit_asked(db, &call, from, tool);
    if seconds == 0 {
        audit_decided(db, &call, Outcome::Unavailable, "timeout");
        return Ok(false);
    }
    let out = ask_frontend_within(
        app,
        "user.ask",
        &ask_payload(question, &options, from, seconds, review),
        None,
        Duration::from_secs(seconds + 1),
    )
    .and_then(unwrap_frontend_result);
    let (outcome, by, ok) = match &out {
        Ok(v) if v["text"] == allow => (Outcome::AllowedOnce, "user", true),
        Ok(_) => (Outcome::Rejected, "user", false),
        Err(_) => (Outcome::Unavailable, "timeout", false),
    };
    audit_decided(db, &call, outcome, by);
    out.map(|_| ok)
}
/// O pedido `user.ask` de uma confirmação. Leva o dono (`owner`), senão o diálogo não sabe que agente
/// pergunta, e a `review` estruturada, para o diálogo mostrar a foto em vez de um caminho.
pub(super) fn ask_payload(question: &str, options: &[&str], from: &str, seconds: u64, review: Option<Value>) -> Value {
    json!({
        "question": question,
        "options": options,
        "tabId": from,
        "owner": { "kind": "tab", "id": from },
        "timeout_s": seconds,
        "review": review,
    })
}

/// A ação em palavras de gente, igual no Mac e no iOS: o gesto diz para onde vai, não só "rolar".
pub(super) fn describe(action: &Action, label: &str, typed: usize, tap: &str) -> String {
    match action.operation {
        Operation::Click => format!("{tap} em «{label}»"),
        Operation::Type => format!("Digitar {typed} caracteres locais no campo já focado"),
        Operation::Scroll => match action.target.as_deref() {
            Some("scroll_up") => "Rolar para baixo".into(),
            Some("scroll_down") => "Rolar para cima".into(),
            Some("swipe_left") => "Deslizar para a esquerda".into(),
            Some("swipe_right") => "Deslizar para a direita".into(),
            Some("home") => "Ir para a tela inicial".into(),
            _ => "Rolar a tela".into(),
        },
        _ => "Executar ação".into(),
    }
}

/// O texto da confirmação, para a auditoria e para quem lê só texto. Sem `None` cru: o ponto só
/// aparece quando existe.
pub(super) fn confirm_question(place: &str, what: &str, photo: &str, point: Option<(f64, f64)>) -> String {
    let point = point
        .map(|(x, y)| format!("\nPonto na foto: {:.0}% da largura, {:.0}% da altura.", x * 100.0, y * 100.0))
        .unwrap_or_default();
    format!(
        "Confirma esta ação {place}?\n{what}.\nO efeito foi classificado como sensível ou incerto.\nFoto local para revisão: {photo}{point}\nA aprovação vale só para esta ação nesta tela."
    )
}

/// O que o diálogo desenha: onde, o quê, a foto (URL de dados, já reduzida a 1.200 px) e o ponto em
/// proporção. Foto ilegível não impede a pergunta: o diálogo cai no texto.
pub(super) fn review(surface: &str, action: &str, photo: &std::path::Path, point: Option<(f64, f64)>) -> Value {
    let image = crate::conversa::attach::read_preview(&photo.to_string_lossy()).ok().map(|i| i.data_url);
    json!({
        "kind": "computer_use",
        "surface": surface,
        "action": action,
        "image": image,
        "point": point.map(|(x, y)| [x, y]),
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
pub(crate) fn audit_asked(db: &DbConnection, call: &str, owner: &str, tool: &str) {
    if let Ok(conn) = db.lock() {
        let _ = approval_audit::asked(&conn, Source::Chat, call, owner, tool, now_ms());
    }
}
pub(crate) fn audit_decided(db: &DbConnection, call: &str, outcome: Outcome, by: &str) {
    if let Ok(conn) = db.lock() {
        let _ = approval_audit::decided(&conn, Source::Chat, call, outcome, None, by, now_ms());
    }
}

struct DeskSurface {
    db: DbConnection,
    app: AppHandle,
    from: String,
    session: Option<String>,
    client_pid: Option<u32>,
    width: f64,
    height: f64,
    deadline: Instant,
    frame: Arc<Mutex<Frame>>,
    fills: Vec<String>,
    expect: Vec<String>,
    typed_this_run: bool,
}
impl DeskSurface {
    fn photo(&self) -> Result<(PathBuf, String), String> {
        let tmp = std::env::temp_dir().join(format!("ags-desk-{}.png", uuid::Uuid::new_v4().simple()));
        let mut cmd = crate::util::spawn::hidden_command("/usr/sbin/screencapture");
        cmd.args(["-x", "-t", "png"]).arg(&tmp);
        let ok = crate::util::spawn::output(
            &mut cmd,
            self.deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(15)),
        )
        .is_ok_and(|o| o.status.success());
        if !ok {
            let _ = std::fs::remove_file(&tmp);
            return Err("Não consegui fotografar a tela.".into());
        }
        prepare_photo(tmp, "desktop", "desk-act", self.deadline)
    }
}
impl Surface for DeskSurface {
    fn authorize(&mut self) -> Result<(), Failure> {
        if Instant::now() >= self.deadline {
            return Err(Failure::Timeout);
        }
        crate::terminal::authorize_actor(self.session.as_deref(), Some(&self.from), self.client_pid)
            .map(|_| ())
            .map_err(|_| Failure::OutsideScope)
    }
    fn observe(&mut self) -> Result<Observation, String> {
        let (path, revision) = self.photo()?;
        let mut fresh = Frame {
            labels: vec![],
            path,
            revision: revision.clone(),
            pick: None,
        };
        self.authorize()
            .map_err(|_| "Autorização ou prazo expirou durante a captura.")?;
        let png = std::fs::read(&fresh.path).map_err(|_| "Foto indisponível.")?;
        let (w, h) = crate::decisions::vision::png_size(&png).ok_or("Tamanho da foto indisponível.")?;
        if h == 0 || (f64::from(w) / f64::from(h) - self.width / self.height).abs() > 0.03 {
            return Err("A tela mudou de tamanho ou de monitor; tente de novo.".into());
        }
        let (text, labels) = ocr(&fresh.path, self.deadline)?;
        fresh.labels = labels;
        let mut local_only = marked_key(&self.db, PRIVATE_KEY)?;
        let ordinary = !private_screen(&text) && !self.fills.iter().any(|v| !v.is_empty() && text.contains(v));
        let verified = !self.expect.is_empty() && self.expect.iter().all(|e| text.contains(e));
        if local_only && !self.typed_this_run && ordinary && !verified {
            let question = format!(
                "Privacidade do Mac: um act anterior digitou dados locais. Apague TODOS os valores escritos por --fill antes de continuar. Confirma que nenhum deles está visível na tela agora?\nFoto local: {}\nSe algum valor ainda aparece, recuse.",
                fresh.path.display()
            );
            if ask_audited(&self.app, &self.db, &self.from, "computer_use:privacy", &question, [ALLOW, DENY], ALLOW, self.deadline, None)? {
                let (check, current) = self.photo()?;
                let _ = std::fs::remove_file(check);
                self.authorize().map_err(|_| "Autorização expirou.")?;
                if current == revision {
                    mark_key(&self.db, PRIVATE_KEY, false)?;
                    local_only = false;
                }
            }
        }
        let safe = ordinary && !local_only;
        *self.frame.lock().map_err(|_| "Foto indisponível.")? = fresh;
        let target = |id: &str, label: &str, ops: Vec<Operation>| Target {
            id: id.into(),
            label: label.into(),
            operations: ops,
            risk: Risk::Ordinary,
        };
        Ok(Observation {
            revision,
            text,
            safe_for_provider: safe,
            targets: vec![
                target("screen", "Controle na foto atual", vec![Operation::Click, Operation::Type]),
                target("scroll_up", "Rolar para baixo", vec![Operation::Scroll]),
                target("scroll_down", "Rolar para cima", vec![Operation::Scroll]),
            ],
        })
    }
    fn confirm(&mut self, revision: &str, action: &Action) -> Result<bool, String> {
        let (label, point, path) = {
            let frame = self.frame.lock().map_err(|_| "Foto indisponível.")?;
            if frame.revision != revision {
                return Ok(false);
            }
            let point = frame.pick.as_ref().and_then(|p| p.point);
            let label = point
                .and_then(|(x, y)| {
                    frame.labels.iter().find(|l| {
                        x >= l.left - 0.02 && x <= l.right + 0.02 && y >= l.top - 0.02 && y <= l.bottom + 0.02
                    })
                })
                .map(|l| l.text.chars().take(200).collect::<String>())
                .unwrap_or_else(|| "controle sem rótulo reconhecido".into());
            (label, point, frame.path.display().to_string())
        };
        let tool = match action.operation {
            Operation::Click => "computer_use:click",
            Operation::Type => "computer_use:type",
            Operation::Scroll => "computer_use:scroll",
            _ => "computer_use:other",
        };
        let typed = self.fills.first().map_or(0, |v| v.chars().count());
        let what = describe(action, &label, typed, "Clicar");
        let question = confirm_question("no seu Mac", &what, &path, point);
        let review = review("mac", &what, std::path::Path::new(&path), point);
        ask_audited(&self.app, &self.db, &self.from, tool, &question, [ALLOW, DENY], ALLOW, self.deadline, Some(review))
    }
    fn execute(&mut self, revision: &str, action: &Action, value: Option<&str>) -> Result<bool, String> {
        let (path, current) = self.photo()?;
        let _ = std::fs::remove_file(path);
        if current != revision {
            return Ok(false);
        }
        self.authorize().map_err(|_| "Autorização expirou.")?;
        let pick = {
            let frame = self.frame.lock().map_err(|_| "Foto indisponível.")?;
            if frame.revision != revision {
                return Ok(false);
            }
            frame.pick.clone().ok_or("Ação sem decisão visual.")?
        };
        let deadline = self.deadline;
        let run = |args: &[&str]| -> Result<(), String> {
            let out = input(args, deadline)?;
            if out.status.success() { Ok(()) } else { Err("A entrada local falhou.".into()) }
        };
        match action.operation {
            Operation::Click => {
                let (x, y) = pick
                    .point
                    .and_then(|p| to_points(p, self.width, self.height))
                    .ok_or("Clique sem coordenada validada.")?;
                run(&["click", &x.to_string(), &y.to_string()])?;
            }
            Operation::Type => {
                let text = value.ok_or("Preenchimento ausente.")?;
                // Antes da entrada: uma falha pode vir depois de digitar.
                mark_key(&self.db, PRIVATE_KEY, true)?;
                self.typed_this_run = true;
                self.authorize().map_err(|_| "Autorização expirou antes de digitar.")?;
                run(&["type", text])?;
            }
            Operation::Scroll => run(&["scroll", &scroll_delta(action.target.as_deref()).to_string()])?,
            _ => return Err("Operação do Mac não oferecida.".into()),
        }
        Ok(true)
    }
}

pub(crate) fn act(
    app: &AppHandle,
    db: DbConnection,
    caller: Caller,
    request: &Request,
    timeout: Duration,
) -> Result<Report, String> {
    let deadline = Instant::now() + timeout;
    if !cfg!(target_os = "macos") {
        return Err("O computer use do Mac exige macOS.".into());
    }
    {
        let mut b = busy().lock().map_err(|_| "Estado indisponível.")?;
        if *b {
            return Err("Já há um act no Mac. Espere ele terminar.".into());
        }
        *b = true;
    }
    let _lease = Lease;
    computer::ready(&db)?;
    match input(&["check"], deadline)?.status.code() {
        Some(0) => {}
        Some(3) => return Err(Failure::AccessibilityPermission.message().into()),
        Some(4) => return Err(Failure::ScreenRecordingPermission.message().into()),
        _ => return Err("Não consegui verificar as permissões do Mac.".into()),
    }
    let bounds = input(&["bounds"], deadline)?;
    let (width, height) = parse_bounds(&String::from_utf8_lossy(&bounds.stdout)).ok_or("Tela principal indisponível.")?;
    // O início é a autorização: sem a pessoa, nada é fotografado nem enviado.
    if !ask_audited(
        app,
        &db,
        &caller.tab,
        "computer_use:desktop",
        &consent_question(&request.goal, request.steps),
        [GRANT, DENY],
        GRANT,
        deadline,
        None,
    )? {
        return Ok(Report {
            status: Status::Blocked,
            actions: vec![],
            reason: "A pessoa não autorizou o controle do Mac; nada foi observado.".into(),
            observations: 0,
            queries: 0,
        });
    }
    let frame = Arc::new(Mutex::new(Frame::default()));
    let mut surface = DeskSurface {
        db: db.clone(),
        app: app.clone(),
        from: caller.tab,
        session: caller.session,
        client_pid: caller.client_pid,
        width,
        height,
        deadline,
        frame: frame.clone(),
        fills: request.fills.values().cloned().collect(),
        expect: request.expect.clone(),
        typed_this_run: false,
    };
    let mut decider = VisualDecider {
        db,
        frame,
        allow_type: request.fills.contains_key("screen"),
        surface: "desktop",
        gestures: false,
    };
    Ok(run(request, &mut surface, &mut decider))
}

#[cfg(test)]
mod test;
