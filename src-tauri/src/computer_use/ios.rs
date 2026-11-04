//! Driver do simulador. Foto e HID existentes; nenhuma alteração no caminho de quadros.
use super::*;
use crate::{
    canvas,
    database::DbConnection,
    decisions::vision::computer,
    ipc::bridge::{ask_frontend_within, unwrap_frontend_result},
    simulator::ops,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::AppHandle;

fn active() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}
// Guarda persistente, sem valor digitado: reiniciar o app não libera fotos de fills antigos.
fn marked(db: &DbConnection, udid: &str) -> Result<bool, String> {
    marked_key(db, &format!("computer_use.ios.private.{udid}"))
}
pub(super) fn marked_key(db: &DbConnection, key: &str) -> Result<bool, String> {
    use rusqlite::OptionalExtension;
    let conn = db
        .lock()
        .map_err(|_| "Estado de privacidade indisponível.")?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Estado de privacidade indisponível.")?;
    Ok(value.as_deref() == Some("1"))
}
pub(super) const ALLOW: &str = "Autorizar esta ação";
pub(super) const ALWAYS: &str = "Autorizar sempre neste aparelho";
pub(super) const DENY: &str = "Recusar";
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Answer {
    Once,
    Always,
    No,
}
/// "Sempre neste aparelho", gravado no banco: vale entre sessões até a pessoa desligar a chave
/// "Permitir que agentes controlem dispositivos" (`computer_use_forget`).
const TRUST_PREFIX: &str = "computer_use.ios.trust.";
fn trusted(db: &DbConnection, udid: &str) -> Result<bool, String> {
    marked_key(db, &format!("{TRUST_PREFIX}{udid}"))
}
fn trust(db: &DbConnection, udid: &str, on: bool) -> Result<(), String> {
    mark_key(db, &format!("{TRUST_PREFIX}{udid}"), on)
}
/// Esquece o "sempre" de todos os aparelhos. Devolve quantos estavam marcados.
pub(crate) fn forget_trust(db: &DbConnection) -> Result<usize, String> {
    let conn = db.lock().map_err(|_| "Estado indisponível.")?;
    conn.execute("DELETE FROM settings WHERE key LIKE ?1", [format!("{TRUST_PREFIX}%")])
        .map_err(|_| "Não consegui esquecer as autorizações.".to_string())
}
/// O que pergunta mesmo com "sempre": tocar num controle de pagar, apagar, senha, sair, enviar…
pub(super) fn always_asks(action: &Action, label: &str) -> bool {
    action.operation == Operation::Click && sensitive_label(label)
}
fn mark(db: &DbConnection, udid: &str, private: bool) -> Result<(), String> {
    mark_key(db, &format!("computer_use.ios.private.{udid}"), private)
}
pub(super) fn mark_key(db: &DbConnection, key: &str, private: bool) -> Result<(), String> {
    db.lock().map_err(|_|"Estado de privacidade indisponível.")?.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,if private {"1"} else {"0"}]).map_err(|_|"Estado de privacidade indisponível.")?;
    Ok(())
}
struct Lease(String);
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut s) = active().lock() {
            s.remove(&self.0);
        }
    }
}
#[derive(Clone, serde::Deserialize)]
pub(super) struct Label {
    pub text: String,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}
/// O texto do controle sob o ponto, com a mesma folga de `named_point`.
pub(super) fn label_at(point: Option<(f64, f64)>, labels: &[Label]) -> Option<&str> {
    let (x, y) = point?;
    labels
        .iter()
        .find(|l| {
            !l.text.trim().is_empty()
                && x >= l.left - 0.02
                && x <= l.right + 0.02
                && y >= l.top - 0.02
                && y <= l.bottom + 0.02
        })
        .map(|l| l.text.as_str())
}
pub(super) fn named_point(point: Option<(f64, f64)>, labels: &[Label]) -> bool {
    point.is_some_and(|(x, y)| {
        labels.iter().any(|l| {
            !l.text.trim().is_empty()
                && x >= l.left - 0.02
                && x <= l.right + 0.02
                && y >= l.top - 0.02
                && y <= l.bottom + 0.02
        })
    })
}
#[derive(Default)]
pub(super) struct Frame {
    pub labels: Vec<Label>,
    pub path: PathBuf,
    pub revision: String,
    pub pick: Option<computer::Pick>,
}
impl Drop for Frame {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub(crate) fn private_screen(text: &str) -> bool {
    let lower: String = text
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    secret(text)
        || [
            "password",
            "senha",
            "contraseña",
            "passcode",
            "códigodeacesso",
            "códigodeverificação",
            "verificationcode",
            "one-timecode",
            "securitycode",
            "cvv",
            "cvc",
            "passwort",
            "motdepasse",
            "apikey",
            "token",
            "cpf",
            "cartão",
            "creditcard",
            "••",
            "●●",
            "***",
        ]
        .iter()
        .any(|v| lower.contains(v))
}
pub(super) fn image_revision(bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Foto PNG inválida.".into());
    }
    let mut hash = Sha256::new();
    let mut offset = 8usize;
    let mut image = false;
    while offset + 12 <= bytes.len() {
        let len = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "PNG inválido.")?,
        ) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|o| o.checked_add(len))
            .filter(|e| *e <= bytes.len())
            .ok_or("PNG truncado.")?;
        let kind = &bytes[offset + 4..offset + 8];
        if [b"IHDR", b"IDAT", b"PLTE", b"tRNS"]
            .iter()
            .any(|k| kind == *k)
        {
            hash.update(kind);
            hash.update(&bytes[offset + 8..end - 4]);
        }
        if kind == b"IDAT" {
            image = true;
        }
        offset = end;
    }
    if !image {
        return Err("PNG sem imagem.".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn capture(udid: &str, deadline: Instant) -> Result<(PathBuf, String), String> {
    if Instant::now() >= deadline {
        return Err("Prazo de captura esgotado.".into());
    }
    let tmp = PathBuf::from(ops::screenshot(udid)?);
    prepare_photo(tmp, udid, "ios-act", deadline)
}
/// Reduz a foto a 1.200 px, na pasta de capturas permitida, e calcula a revisão. Apaga `tmp`.
pub(super) fn prepare_photo(tmp: PathBuf, id: &str, prefix: &str, deadline: Instant) -> Result<(PathBuf, String), String> {
    if Instant::now() >= deadline {
        let _ = std::fs::remove_file(tmp);
        return Err("Prazo de captura esgotado.".into());
    }
    let dir = crate::preview::capture::capture_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{prefix}-{}.png", uuid::Uuid::new_v4().simple()));
    let mut cmd = crate::util::spawn::hidden_command("/usr/bin/sips");
    cmd.args(["-Z", "1200"]).arg(&tmp).arg("--out").arg(&path);
    let result = crate::util::spawn::output(
        &mut cmd,
        deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(15)),
    );
    let _ = std::fs::remove_file(tmp);
    let out = match result {
        Ok(out) => out,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            return Err("Não consegui preparar a foto.".into());
        }
    };
    if !out.status.success() {
        let _ = std::fs::remove_file(path);
        return Err("Não consegui preparar a foto.".into());
    }
    let revision = std::fs::read(&path)
        .map_err(|_| "Foto indisponível.".to_string())
        .and_then(|bytes| image_revision(&bytes));
    match revision {
        Ok(revision) => Ok((path, format!("{id}:{revision}"))),
        Err(error) => {
            let _ = std::fs::remove_file(path);
            Err(error)
        }
    }
}
pub(super) fn ocr(path: &std::path::Path, deadline: Instant) -> Result<(String, Vec<Label>), String> {
    if Instant::now() >= deadline {
        return Err("Prazo do OCR local esgotado.".into());
    }
    let mut cmd = crate::util::spawn::hidden_command("/usr/bin/swift");
    cmd.arg("-e").arg(include_str!("ios_ocr.swift")).arg(path);
    let out = crate::util::spawn::output(
        &mut cmd,
        deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(30)),
    )
    .map_err(|_| "OCR local indisponível.")?;
    if !out.status.success() {
        return Err("OCR local falhou; não enviei a foto.".into());
    }
    let lines: Vec<Label> =
        serde_json::from_slice(&out.stdout).map_err(|_| "OCR local inválido.")?;
    let text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.len() > 24_000 {
        return Err("Texto da foto excedeu o limite local.".into());
    }
    Ok((text, lines))
}
struct IosSurface {
    db: DbConnection,
    typed_this_run: bool,
    app: AppHandle,
    from: String,
    session: Option<String>,
    client_pid: Option<u32>,
    node: String,
    udid: String,
    width: f64,
    height: f64,
    deadline: Instant,
    frame: Arc<Mutex<Frame>>,
    fills: Vec<String>,
    expect: Vec<String>,
    /// O OCR da foto que `settled` já leu, para a observação não ler de novo.
    read_ahead: Option<(String, Vec<Label>)>,
}
/// Menos que isto de linhas de texto é tela ainda carregando (um app abrindo, uma transição).
const MIN_LABELS: usize = 2;
/// Quantas vezes esperar a tela assentar antes de mostrar o que houver ao decisor, e quanto esperar.
const SETTLE_TRIES: usize = 6;
const SETTLE_WAIT: Duration = Duration::from_millis(800);

/// Esperar outra foto: só com a tela quase sem texto, tentativas sobrando e prazo para mais uma espera.
pub(super) fn should_settle(labels: usize, try_no: usize, time_left: Duration) -> bool {
    labels < MIN_LABELS && try_no + 1 < SETTLE_TRIES && time_left > SETTLE_WAIT * 4
}

impl IosSurface {
    /// A foto de uma tela já assentada: logo depois de abrir um app o iOS ainda está desenhando e o OCR lê só o
    /// relógio. Uma foto assim faria o decisor gastar uma consulta para responder "não sei". O OCR feito aqui é
    /// reaproveitado pela observação.
    fn settled(&mut self) -> Result<(PathBuf, String), String> {
        let mut try_no = 0;
        loop {
            let (path, revision) = capture(&self.udid, self.deadline)?;
            let read = ocr(&path, self.deadline)?;
            if !should_settle(read.1.len(), try_no, self.deadline.saturating_duration_since(Instant::now())) {
                self.read_ahead = Some(read);
                return Ok((path, revision));
            }
            let _ = std::fs::remove_file(&path);
            try_no += 1;
            std::thread::sleep(SETTLE_WAIT);
        }
    }

    /// A confirmação por ação oferece "sempre neste aparelho"; a de privacidade (`review` = None), não.
    fn ask(&self, question: &str, review: Option<serde_json::Value>) -> Result<Answer, String> {
        let seconds = self
            .deadline
            .saturating_duration_since(Instant::now())
            .as_secs()
            .min(1800);
        if seconds == 0 {
            return Ok(Answer::No);
        }
        let options: &[&str] = if review.is_some() { &[ALLOW, ALWAYS, DENY] } else { &[ALLOW, DENY] };
        let payload = super::desktop::ask_payload(question, options, &self.from, seconds, review);
        // Sem resposta (fechou, prazo, tela indisponível) é recusa, não falha da superfície: nada foi feito.
        let Ok(out) = ask_frontend_within(&self.app, "user.ask", &payload, None, Duration::from_secs(seconds + 1))
            .and_then(unwrap_frontend_result)
        else {
            return Ok(Answer::No);
        };
        Ok(match out["text"].as_str() {
            Some(ALLOW) => Answer::Once,
            Some(ALWAYS) if options.contains(&ALWAYS) => Answer::Always,
            _ => Answer::No,
        })
    }
}
impl Surface for IosSurface {
    fn authorize(&mut self) -> Result<(), Failure> {
        if Instant::now() >= self.deadline {
            return Err(Failure::Timeout);
        }
        crate::terminal::authorize_actor(self.session.as_deref(), Some(&self.from), self.client_pid)
            .map_err(|_| Failure::OutsideScope)?;
        let allowed = crate::surfaces::ios_allows(&self.from, &self.node, &self.udid, "act");
        if !allowed {
            return Err(Failure::OutsideScope);
        }
        if !ops::booted(&self.udid).map_err(|_| Failure::Operation)? {
            return Err(Failure::Operation);
        }
        crate::simulator::lifecycle::used(&self.udid);
        Ok(())
    }
    fn observe(&mut self) -> Result<Observation, String> {
        let (path, revision) = self.settled()?;
        let mut fresh = Frame {
            labels: vec![],
            path,
            revision: revision.clone(),
            pick: None,
        };
        self.authorize()
            .map_err(|_| "Autorização ou prazo expirou durante a captura.")?;
        let png = std::fs::read(&fresh.path).map_err(|_| "Foto indisponível.")?;
        let (w, h) =
            crate::decisions::vision::png_size(&png).ok_or("Tamanho da foto indisponível.")?;
        if h == 0
            || self.height <= 0.
            || (f64::from(w) / f64::from(h) - self.width / self.height).abs() > 0.03
        {
            return Err(
                "Orientação da foto não confere com o HID; rotação ainda não é suportada.".into(),
            );
        }
        let (text, labels) = match self.read_ahead.take() {
            Some(read) => read,
            None => ocr(&fresh.path, self.deadline)?,
        };
        fresh.labels = labels;
        let mut local_only = marked(&self.db, &self.udid)?;
        let ordinary =
            !private_screen(&text) && !self.fills.iter().any(|v| !v.is_empty() && text.contains(v));
        let locally_verified =
            !self.expect.is_empty() && self.expect.iter().all(|e| text.contains(e));
        if local_only && !self.typed_this_run && ordinary && !locally_verified {
            let question = format!(
                "Privacidade do simulador: um act anterior digitou dados locais. Limpe TODOS os dados escritos por --fill antes de continuar. Confirma que nenhum desses valores está visível nesta foto atual?\nFoto local: {}\nSe algum valor ainda aparece, recuse. Esta confirmação não autoriza fotos de senha detectada.",
                fresh.path.display()
            );
            if self.ask(&question, None)? != Answer::No {
                let (check, current) = capture(&self.udid, self.deadline)?;
                let _ = std::fs::remove_file(check);
                self.authorize().map_err(|_| "Autorização expirou.")?;
                if current == revision {
                    mark(&self.db, &self.udid, false)?;
                    local_only = false;
                }
            }
        }
        let safe = ordinary && !local_only;
        *self.frame.lock().map_err(|_| "Foto indisponível.")? = fresh;
        Ok(Observation {
            revision,
            text,
            safe_for_provider: safe,
            targets: vec![
                Target {
                    id: "screen".into(),
                    label: "Controle na foto atual".into(),
                    operations: vec![Operation::Click, Operation::Type],
                    risk: Risk::Ordinary,
                },
                Target {
                    id: "scroll_up".into(),
                    label: "Rolar para baixo".into(),
                    operations: vec![Operation::Scroll],
                    risk: Risk::Ordinary,
                },
                Target {
                    id: "scroll_down".into(),
                    label: "Rolar para cima".into(),
                    operations: vec![Operation::Scroll],
                    risk: Risk::Ordinary,
                },
                Target {
                    id: "swipe_left".into(),
                    label: "Deslizar para a esquerda".into(),
                    operations: vec![Operation::Scroll],
                    risk: Risk::Ordinary,
                },
                Target {
                    id: "swipe_right".into(),
                    label: "Deslizar para a direita".into(),
                    operations: vec![Operation::Scroll],
                    risk: Risk::Ordinary,
                },
                Target {
                    id: "home".into(),
                    label: "Ir para a tela inicial".into(),
                    operations: vec![Operation::Scroll],
                    risk: Risk::Ordinary,
                },
            ],
        })
    }
    fn confirm(&mut self, revision: &str, action: &Action) -> Result<bool, String> {
        let frame = self.frame.lock().map_err(|_| "Foto indisponível.")?;
        if frame.revision != revision {
            return Ok(false);
        }
        let point = frame.pick.as_ref().and_then(|p| p.point);
        let label = point
            .and_then(|(x, y)| {
                frame.labels.iter().find(|l| {
                    x >= l.left - 0.02
                        && x <= l.right + 0.02
                        && y >= l.top - 0.02
                        && y <= l.bottom + 0.02
                })
            })
            .map(|l| l.text.chars().take(200).collect::<String>())
            .unwrap_or_else(|| "controle sem rótulo reconhecido".into());
        let typed = self.fills.first().map_or(0, |v| v.chars().count());
        let operation = super::desktop::describe(action, &label, typed, "Tocar");
        let path = frame.path.clone();
        drop(frame);
        // A pessoa já disse "sempre" para este aparelho: só o que é de fato perigoso volta a perguntar.
        if !always_asks(action, &label) && trusted(&self.db, &self.udid)? {
            return Ok(true);
        }
        let question =
            super::desktop::confirm_question("no simulador iOS", &operation, &path.display().to_string(), point);
        let review = super::desktop::review("ios", &operation, &path, point);
        match self.ask(&question, Some(review))? {
            Answer::Always => {
                trust(&self.db, &self.udid, true)?;
                Ok(true)
            }
            Answer::Once => Ok(true),
            Answer::No => Ok(false),
        }
    }
    fn execute(
        &mut self,
        revision: &str,
        action: &Action,
        value: Option<&str>,
    ) -> Result<bool, String> {
        // A foto é conferida depois de decidir e depois do eventual diálogo humano.
        let (path, current) = capture(&self.udid, self.deadline)?;
        let _ = std::fs::remove_file(path);
        if current != revision {
            return Ok(false);
        }
        self.authorize().map_err(|_| "Autorização expirou.")?;
        let frame = self.frame.lock().map_err(|_| "Foto indisponível.")?;
        if frame.revision != revision {
            return Ok(false);
        }
        let pick = frame
            .pick
            .as_ref()
            .ok_or("Ação sem decisão visual.")?
            .clone();
        drop(frame);
        match action.operation {
            Operation::Click => {
                let (x, y) = pick.point.ok_or("Toque sem coordenada validada.")?;
                ops::tap(&self.udid, x * self.width, y * self.height)?;
            }
            Operation::Type => {
                let text = value.ok_or("Preenchimento ausente.")?;
                // Antes do HID: uma falha de transporte pode ocorrer depois de digitar.
                mark(&self.db, &self.udid, true)?;
                self.typed_this_run = true;
                self.authorize()
                    .map_err(|_| "Autorização expirou antes de digitar.")?;
                ops::type_text(&self.udid, text)?;
            }
            Operation::Scroll => match action.target.as_deref() {
                Some("home") => ops::button(&self.udid, "home")?,
                Some(target) => {
                    let ((x1, y1), (x2, y2)) = gesture_line(target).ok_or("Gesto iOS não oferecido.")?;
                    ops::swipe(&self.udid, (self.width * x1, self.height * y1), (self.width * x2, self.height * y2), 300)?;
                }
                None => return Err("Gesto iOS sem alvo.".into()),
            },
            _ => return Err("Operação iOS não oferecida.".into()),
        }
        Ok(true)
    }
}
/// O traço do dedo de cada gesto, em proporção da tela: rolar na vertical pelo meio; deslizar na horizontal na
/// altura do meio, longe das bordas (a borda esquerda vira "voltar" e a de baixo, a barra de início).
pub(super) fn gesture_line(target: &str) -> Option<((f64, f64), (f64, f64))> {
    Some(match target {
        "scroll_up" => ((0.5, 0.75), (0.5, 0.25)),
        "scroll_down" => ((0.5, 0.25), (0.5, 0.75)),
        "swipe_left" => ((0.8, 0.5), (0.2, 0.5)),
        "swipe_right" => ((0.2, 0.5), (0.8, 0.5)),
        _ => return None,
    })
}

pub(super) fn decision_for(pick: &computer::Pick, text: &str, labels: &[Label]) -> Result<Decision, String> {
    let (operation, target) = match pick.operation.as_str() {
        "click" => (Operation::Click, Some("screen".into())),
        "type" => (Operation::Type, Some("screen".into())),
        // Os gestos são da família do rolar: movimento comum, sem efeito sensível, cada um com seu alvo.
        "scroll_up" | "scroll_down" | "swipe_left" | "swipe_right" | "home" => (Operation::Scroll, Some(pick.operation.clone())),
        "done" => (Operation::Done, None),
        "stuck" => (Operation::Stuck, None),
        _ => return Err("Operação não oferecida.".into()),
    };
    let unnamed_click = operation == Operation::Click && !named_point(pick.point, labels);
    // O risco é do controle tocado, não da tela inteira: um "Sair" no canto da tela não torna
    // sensível rolar nem tocar em «Geral». Sem rótulos (teste, OCR vazio), vale o texto todo.
    let touched = if labels.is_empty() {
        sensitive_label(text)
    } else {
        operation == Operation::Click && label_at(pick.point, labels).is_some_and(sensitive_label)
    };
    Ok(Decision {
        requires_confirmation: pick.confirm
            || touched
            || unnamed_click
            || operation == Operation::Type,
        action: Action { operation, target },
        probability: pick.probability,
        goal_done: pick.goal_done,
    })
}

pub(super) struct VisualDecider {
    pub db: DbConnection,
    pub frame: Arc<Mutex<Frame>>,
    pub allow_type: bool,
    pub surface: &'static str,
    /// Deslizar para os lados e ir para a tela inicial (só no iOS).
    pub gestures: bool,
}
impl Decider for VisualDecider {
    fn decide(
        &mut self,
        goal: &str,
        obs: &Observation,
        actions: &[Action],
    ) -> Result<Decision, String> {
        let (path, labels) = {
            let f = self.frame.lock().map_err(|_| "Foto indisponível.")?;
            if f.revision != obs.revision {
                return Err("Foto desatualizada.".into());
            }
            let labels: Vec<computer::TextBox> = f
                .labels
                .iter()
                .map(|l| computer::TextBox {
                    text: l.text.clone(),
                    rect: crate::decisions::vision::Rect { left: l.left, right: l.right, top: l.top, bottom: l.bottom },
                })
                .collect();
            (f.path.to_string_lossy().into_owned(), labels)
        };
        let recent = serde_json::to_string(actions).map_err(|_| "Histórico inválido.")?;
        let pick = computer::pick(
            &self.db,
            &computer::Query {
                goal,
                recent: &recent,
                path: &path,
                allow_type: self.allow_type,
                surface: self.surface,
                labels: &labels,
                gestures: self.gestures,
            },
        )?;
        let decision = {
            let f = self.frame.lock().map_err(|_| "Foto indisponível.")?;
            decision_for(&pick, &obs.text, &f.labels)?
        };
        let mut f = self.frame.lock().map_err(|_| "Foto indisponível.")?;
        if f.revision != obs.revision {
            return Err("Foto desatualizada.".into());
        }
        f.pick = Some(pick);
        Ok(decision)
    }
}

pub(crate) struct Caller {
    pub tab: String,
    pub session: Option<String>,
    pub client_pid: Option<u32>,
}

pub(crate) fn act(
    app: &AppHandle,
    db: DbConnection,
    caller: Caller,
    node: &str,
    udid: &str,
    request: &Request,
    timeout: Duration,
) -> Result<Report, String> {
    let deadline = Instant::now() + timeout;
    if !cfg!(target_os = "macos") {
        return Err("O simulador iOS exige macOS e Xcode.".into());
    }
    if !active()
        .lock()
        .map_err(|_| "Estado indisponível.")?
        .insert(udid.into())
    {
        return Err("Já há um act neste simulador. Espere ele terminar.".into());
    }
    let _lease = Lease(udid.into());
    computer::ready(&db)?;
    let device = ops::devices()?
        .into_iter()
        .find(|d| d.udid == udid)
        .ok_or("Aparelho indisponível.")?;
    if !device.width.is_finite()
        || !device.height.is_finite()
        || device.width <= 0.
        || device.height <= 0.
    {
        return Err("Dimensões do aparelho indisponíveis.".into());
    }
    let frame = Arc::new(Mutex::new(Frame::default()));
    let mut surface = IosSurface {
        db: db.clone(),
        typed_this_run: false,
        app: app.clone(),
        from: caller.tab,
        session: caller.session,
        client_pid: caller.client_pid,
        node: node.into(),
        udid: udid.into(),
        width: device.width,
        height: device.height,
        deadline,
        frame: frame.clone(),
        fills: request.fills.values().cloned().collect(),
        expect: request.expect.clone(),
        read_ahead: None,
    };
    let mut decider = VisualDecider {
        db,
        frame,
        allow_type: request.fills.contains_key("screen"),
        surface: "iOS",
        gestures: true,
    };
    Ok(run(request, &mut surface, &mut decider))
}

#[cfg(test)]
mod test {
    use super::*;
    #[test]
    fn guarda_local_recusa_rotulos_sensiveis_mas_nao_texto_ordinario() {
        for s in [
            "Senha",
            "S e n h a",
            "• • •",
            "Enter password",
            "Contraseña",
            "••••",
            "CPF",
            "Credit card",
            "password: hunter2",
        ] {
            assert!(private_screen(s), "{s}");
        }
        assert!(!private_screen("Safari Ajustes Início Buscar"));
    }
}

#[cfg(test)]
mod guards_test {
    use super::*;
    #[test]
    fn revisao_ignora_metadados_mas_nao_mudanca_na_imagem() {
        fn png(stamp: &[u8], image: &[u8]) -> Vec<u8> {
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            for (kind, data) in [(b"tEXt", stamp), (b"IDAT", image)] {
                bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
                bytes.extend_from_slice(kind);
                bytes.extend_from_slice(data);
                bytes.extend_from_slice(&[0; 4]);
            }
            bytes
        }
        assert_eq!(
            image_revision(&png(b"t1", b"pixels")).unwrap(),
            image_revision(&png(b"t2", b"pixels")).unwrap()
        );
        assert_ne!(
            image_revision(&png(b"t1", b"pixels")).unwrap(),
            image_revision(&png(b"t1", b"outros")).unwrap()
        );
        assert!(image_revision(b"nao PNG").is_err());
    }
    #[test]
    fn icone_sem_rotulo_pede_confirmacao() {
        let labels = vec![Label {
            text: "Abrir".into(),
            left: 0.1,
            right: 0.3,
            top: 0.2,
            bottom: 0.3,
        }];
        assert!(named_point(Some((0.2, 0.25)), &labels));
        assert!(!named_point(Some((0.8, 0.8)), &labels));
        assert!(!named_point(None, &labels));
    }
    #[test]
    fn marcador_persistente_nao_armazena_o_valor_digitado() {
        let db = Arc::new(Mutex::new(crate::database::test_db()));
        assert!(!marked(&db, "mock-device").unwrap());
        mark(&db, "mock-device", true).unwrap();
        assert!(marked(&db, "mock-device").unwrap());
        let value: String = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key='computer_use.ios.private.mock-device'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "1");
        mark(&db, "mock-device", false).unwrap();
        assert!(!marked(&db, "mock-device").unwrap());
    }
}

#[cfg(test)]
mod flow_test {
    use super::*;
    struct PhotosAndHid {
        done: bool,
        approve: bool,
        stale: bool,
        taps: usize,
        confirmations: usize,
        point: Arc<Mutex<Option<(f64, f64)>>>,
    }
    impl Surface for PhotosAndHid {
        fn authorize(&mut self) -> Result<(), Failure> {
            Ok(())
        }
        fn observe(&mut self) -> Result<Observation, String> {
            Ok(Observation {
                revision: if self.done { "foto-b" } else { "foto-a" }.into(),
                text: if self.done {
                    "PAINEL ABERTO"
                } else {
                    "Abrir painel"
                }
                .into(),
                safe_for_provider: true,
                targets: vec![Target {
                    id: "screen".into(),
                    label: "Controle na foto".into(),
                    operations: vec![Operation::Click],
                    risk: Risk::Ordinary,
                }],
            })
        }
        fn confirm(&mut self, _: &str, _: &Action) -> Result<bool, String> {
            self.confirmations += 1;
            Ok(self.approve)
        }
        fn execute(
            &mut self,
            revision: &str,
            action: &Action,
            _: Option<&str>,
        ) -> Result<bool, String> {
            if self.stale || revision != "foto-a" {
                return Ok(false);
            }
            assert_eq!(action.operation, Operation::Click);
            let (x, y) = self.point.lock().unwrap().unwrap();
            // A caixa em frações vira pontos do iOS, como no driver real.
            assert!((x * 400. - 120.).abs() < 1e-6 && (y * 800. - 160.).abs() < 1e-6);
            self.taps += 1;
            self.done = true;
            Ok(true)
        }
    }
    struct MockJev {
        point: Arc<Mutex<Option<(f64, f64)>>>,
    }
    impl Decider for MockJev {
        fn decide(&mut self, _: &str, obs: &Observation, _: &[Action]) -> Result<Decision, String> {
            // Resposta no protocolo real, sem HTTP, keyring ou arquivo de imagem.
            let pick = computer::parse(
                r#"{"answers":{"operacao":{"choice":"click","probabilities":{"click":0.98}},"alvo":{"box":{"left":0.2,"right":0.4,"top":0.1,"bottom":0.3},"confidence":0.95},"concluido":{"choice":"no","probabilities":{"no":0.99}},"sensivel":{"choice":"yes","probabilities":{"yes":0.99}}}}"#,
                false,
                true,
                &[],
            )?;
            *self.point.lock().unwrap() = pick.point;
            decision_for(&pick, &obs.text, &[])
        }
    }
    #[test]
    fn tela_quase_sem_texto_espera_assentar_sem_passar_do_prazo_nem_das_tentativas() {
        let folga = Duration::from_secs(30);
        assert!(should_settle(1, 0, folga), "só o relógio: app ainda abrindo");
        assert!(should_settle(0, 1, folga));
        assert!(!should_settle(1, SETTLE_TRIES - 1, folga), "na última tentativa mostra o que houver");
        assert!(!should_settle(MIN_LABELS, 0, folga), "tela com texto segue na hora");
        assert!(!should_settle(0, 0, SETTLE_WAIT), "sem prazo, não espera");
    }
    #[test]
    fn sempre_neste_aparelho_fica_no_banco_e_esquecer_apaga_tudo() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        let db: DbConnection = Arc::new(Mutex::new(conn));
        assert!(!trusted(&db, "A").unwrap());
        trust(&db, "A", true).unwrap();
        trust(&db, "B", true).unwrap();
        assert!(trusted(&db, "A").unwrap() && !trusted(&db, "C").unwrap());
        assert_eq!(forget_trust(&db).unwrap(), 2);
        assert!(!trusted(&db, "A").unwrap() && !trusted(&db, "B").unwrap());
        // A marca de privacidade de fills não é uma confiança e não some junto.
        mark(&db, "A", true).unwrap();
        forget_trust(&db).unwrap();
        assert!(marked(&db, "A").unwrap());
    }
    #[test]
    fn sempre_nao_cobre_tocar_em_pagar_apagar_ou_sair() {
        let click = Action { operation: Operation::Click, target: Some("screen".into()) };
        let scroll = Action { operation: Operation::Scroll, target: Some("scroll_up".into()) };
        assert!(always_asks(&click, "Excluir conta"));
        assert!(always_asks(&click, "Sair"));
        assert!(!always_asks(&click, "Continuar como Eriston"));
        assert!(!always_asks(&scroll, "Sair"));
    }
    #[test]
    fn risco_vem_do_controle_tocado_nao_de_uma_palavra_em_outro_canto_da_tela() {
        let label = |text: &str, top: f64| Label { text: text.into(), left: 0.1, right: 0.9, top, bottom: top + 0.05 };
        let labels = vec![label("Geral", 0.2), label("Sair", 0.8)];
        let pick = |op: &str, point| computer::Pick { operation: op.into(), probability: 0.9, goal_done: None, point, confirm: false };
        let text = "Geral\nSair";
        assert!(!decision_for(&pick("click", Some((0.5, 0.22))), text, &labels).unwrap().requires_confirmation, "tocar em «Geral»");
        assert!(!decision_for(&pick("scroll_up", None), text, &labels).unwrap().requires_confirmation, "rolar não é sair");
        assert!(decision_for(&pick("click", Some((0.5, 0.82))), text, &labels).unwrap().requires_confirmation, "tocar em «Sair»");
        // O julgamento do Jev continua valendo, e sem rótulos o texto todo segue conservador.
        let mut jev = pick("scroll_up", None);
        jev.confirm = true;
        assert!(decision_for(&jev, text, &labels).unwrap().requires_confirmation);
        assert!(decision_for(&pick("scroll_up", None), text, &[]).unwrap().requires_confirmation);
    }
    #[test]
    fn gestos_viram_rolar_com_alvo_proprio_sem_confirmacao_e_com_traco_longe_das_bordas() {
        for op in ["swipe_left", "swipe_right", "home", "scroll_up"] {
            let pick = computer::Pick { operation: op.into(), probability: 0.9, goal_done: None, point: None, confirm: false };
            let d = decision_for(&pick, "Início", &[]).unwrap();
            assert_eq!(d.action, Action { operation: Operation::Scroll, target: Some(op.into()) });
            assert!(!d.requires_confirmation, "{op}");
        }
        let ((x1, y1), (x2, y2)) = gesture_line("swipe_left").unwrap();
        assert!(x1 > x2 && y1 == y2 && x2 >= 0.1 && x1 <= 0.9);
        assert!(gesture_line("swipe_right").is_some_and(|((a, _), (b, _))| a < b));
        assert!(gesture_line("home").is_none(), "o início é o botão, não um traço");
    }
    #[test]
    fn foto_jev_tipado_confirmacao_hid_e_verificacao_fecham_o_percurso_simulado() {
        for (approve, stale, status, taps) in [
            (true, false, Status::Done, 1),
            (false, false, Status::Blocked, 0),
            (true, true, Status::Limit, 0),
        ] {
            let point = Arc::new(Mutex::new(None));
            let mut surface = PhotosAndHid {
                done: false,
                approve,
                stale,
                taps: 0,
                confirmations: 0,
                point: point.clone(),
            };
            let request = Request {
                goal: "abrir painel".into(),
                fills: Default::default(),
                expect: vec!["PAINEL ABERTO".into()],
                steps: 1,
            };
            let report = run(&request, &mut surface, &mut MockJev { point });
            assert_eq!(report.status, status);
            assert_eq!(surface.taps, taps);
            assert_eq!(surface.confirmations, 1);
            assert_eq!(report.queries, 1);
        }
    }
}

