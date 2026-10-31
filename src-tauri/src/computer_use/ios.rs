//! Driver do simulador. Foto e HID existentes; nenhuma alteração no caminho de quadros.
use super::*;
use crate::{
    canvas,
    database::DbConnection,
    decisions::vision::computer,
    ipc::bridge::{ask_frontend_within, unwrap_frontend_result},
    simulator::ops,
};
use serde_json::json;
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
    use rusqlite::OptionalExtension;
    let conn = db
        .lock()
        .map_err(|_| "Estado de privacidade indisponível.")?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("computer_use.ios.private.{udid}")],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Estado de privacidade indisponível.")?;
    Ok(value.as_deref() == Some("1"))
}
fn mark(db: &DbConnection, udid: &str, private: bool) -> Result<(), String> {
    db.lock().map_err(|_|"Estado de privacidade indisponível.")?.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![format!("computer_use.ios.private.{udid}"),if private {"1"} else {"0"}]).map_err(|_|"Estado de privacidade indisponível.")?;
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
struct Label {
    text: String,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}
fn named_point(point: Option<(f64, f64)>, labels: &[Label]) -> bool {
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
struct Frame {
    labels: Vec<Label>,
    path: PathBuf,
    revision: String,
    pick: Option<computer::Pick>,
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
fn image_revision(bytes: &[u8]) -> Result<String, String> {
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
    if Instant::now() >= deadline {
        let _ = std::fs::remove_file(tmp);
        return Err("Prazo de captura esgotado.".into());
    }
    let dir = crate::preview::capture::capture_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("ios-act-{}.png", uuid::Uuid::new_v4().simple()));
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
        Ok(revision) => Ok((path, format!("{udid}:{revision}"))),
        Err(error) => {
            let _ = std::fs::remove_file(path);
            Err(error)
        }
    }
}
fn ocr(path: &std::path::Path, deadline: Instant) -> Result<(String, Vec<Label>), String> {
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
    session: String,
    client_pid: Option<u32>,
    node: String,
    udid: String,
    width: f64,
    height: f64,
    deadline: Instant,
    frame: Arc<Mutex<Frame>>,
    fills: Vec<String>,
    expect: Vec<String>,
}
impl IosSurface {
    fn ask(&self, question: &str) -> Result<bool, String> {
        let seconds = self
            .deadline
            .saturating_duration_since(Instant::now())
            .as_secs()
            .min(1800);
        if seconds == 0 {
            return Ok(false);
        }
        let out=ask_frontend_within(&self.app,"user.ask",&json!({"question":question,"options":["Autorizar esta ação","Recusar"],"tabId":self.from,"timeout_s":seconds}),None,Duration::from_secs(seconds+1)).and_then(unwrap_frontend_result)?;
        Ok(out["text"] == "Autorizar esta ação")
    }
}
impl Surface for IosSurface {
    fn authorize(&mut self) -> Result<(), Failure> {
        if Instant::now() >= self.deadline {
            return Err(Failure::Timeout);
        }
        crate::terminal::authorize(Some(&self.session), Some(&self.from), self.client_pid)
            .map_err(|_| Failure::OutsideScope)?;
        let boards = canvas::load_boards();
        let allowed = canvas::portals_for(&boards, &self.from)
            .iter()
            .any(|(key, id)| {
                id == &self.node
                    && boards
                        .get(key)
                        .and_then(|b| b.portals.get(id))
                        .is_some_and(|p| {
                            p.kind.as_deref() == Some("ios")
                                && p.udid.as_deref() == Some(&self.udid)
                        })
            });
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
        let (path, revision) = capture(&self.udid, self.deadline)?;
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
        let (text, labels) = ocr(&fresh.path, self.deadline)?;
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
            if self.ask(&question)? {
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
        let operation = match action.operation {
            Operation::Click => format!("Tocar em «{label}»"),
            Operation::Type => format!(
                "Digitar {} caracteres locais no campo já focado",
                self.fills.first().map_or(0, |v| v.chars().count())
            ),
            Operation::Scroll => "Rolar a tela".into(),
            _ => "Executar ação".into(),
        };
        let question = format!(
            "Confirma esta ação no simulador iOS?\n{operation}.\nO efeito foi classificado como sensível ou incerto.\nFoto local para revisão: {}\nPonto na foto (proporção): {:?}. A aprovação vale só para esta ação nesta tela.",
            frame.path.display(),
            point
        );
        drop(frame);
        self.ask(&question)
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
            Operation::Scroll => {
                let (a, b) = if action.target.as_deref() == Some("scroll_up") {
                    (0.75, 0.25)
                } else {
                    (0.25, 0.75)
                };
                ops::swipe(
                    &self.udid,
                    (self.width / 2., self.height * a),
                    (self.width / 2., self.height * b),
                    300,
                )?;
            }
            _ => return Err("Operação iOS não oferecida.".into()),
        }
        Ok(true)
    }
}
fn decision_for(pick: &computer::Pick, text: &str, labels: &[Label]) -> Result<Decision, String> {
    let (operation, target) = match pick.operation.as_str() {
        "click" => (Operation::Click, Some("screen".into())),
        "type" => (Operation::Type, Some("screen".into())),
        "scroll_up" | "scroll_down" => (Operation::Scroll, Some(pick.operation.clone())),
        "done" => (Operation::Done, None),
        "stuck" => (Operation::Stuck, None),
        _ => return Err("Operação não oferecida.".into()),
    };
    let unnamed_click = operation == Operation::Click && !named_point(pick.point, labels);
    Ok(Decision {
        requires_confirmation: pick.confirm
            || sensitive_label(text)
            || unnamed_click
            || operation == Operation::Type,
        action: Action { operation, target },
        probability: pick.probability,
        goal_done: pick.goal_done,
    })
}

struct VisualDecider {
    db: DbConnection,
    frame: Arc<Mutex<Frame>>,
    allow_type: bool,
}
impl Decider for VisualDecider {
    fn decide(
        &mut self,
        goal: &str,
        obs: &Observation,
        actions: &[Action],
    ) -> Result<Decision, String> {
        let path = {
            let f = self.frame.lock().map_err(|_| "Foto indisponível.")?;
            if f.revision != obs.revision {
                return Err("Foto desatualizada.".into());
            }
            f.path.to_string_lossy().into_owned()
        };
        let recent = serde_json::to_string(actions).map_err(|_| "Histórico inválido.")?;
        let pick = computer::pick(
            &self.db,
            &computer::Query {
                goal,
                recent: &recent,
                path: &path,
                allow_type: self.allow_type,
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
    pub session: String,
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
    };
    let mut decider = VisualDecider {
        db,
        frame,
        allow_type: request.fills.contains_key("screen"),
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
            )?;
            *self.point.lock().unwrap() = pick.point;
            decision_for(&pick, &obs.text, &[])
        }
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
