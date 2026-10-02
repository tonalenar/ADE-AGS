//! Rotinas: mensagens que a app manda sozinha, no horário.
//!
//! Uma rotina escreve um texto num agente aberto (o mesmo canal de `ccode peer tell`) ou
//! avisa o usuário (um lembrete). Serve para "rode os testes todo dia às 9h", "me lembre
//! daqui a uma hora" ou "revise o que mudou a cada duas horas".
//!
//! Este módulo é o modelo: o que é uma rotina, como se lê um horário e quando é a próxima
//! vez. É puro (o relógio entra como parâmetro) para testar sem esperar. Quem dispara as
//! rotinas, e quem as cria, está em `ipc::commands::routine`.
//!
//! ## Decisões
//!
//! - **Sem recuperar o que se perdeu.** Se a app estava fechada na hora, a rotina não roda
//!   quando ela abre: "todo dia às 9h" aberta às 15h dispararia fora de hora, e uma rotina
//!   a cada 10 min rodaria 50 vezes de uma vez. Recalcula-se a partir de agora. Um lembrete
//!   único perdido fica marcado como perdido, para que não se confunda com um que rodou.
//! - **Intervalo mínimo de 5 minutos.** Um agente não pode se mandar uma mensagem a cada
//!   segundo; o texto dispara um turno inteiro do outro lado.
//! - **Um texto curto, numa linha.** O que a rotina escreve num terminal tem que ser uma
//!   instrução, não um relatório.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};

pub const MAX_ROUTINES: usize = 30;
pub const MAX_TEXT: usize = 1000;
const MAX_NAME: usize = 40;
/// O menor intervalo de uma rotina que se repete.
pub const MIN_EVERY_SECS: i64 = 5 * 60;
/// O menor prazo de um lembrete único.
const MIN_IN_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    /// A cada `secs` segundos, contados desde a última vez.
    Every { secs: i64 },
    /// Todo dia (ou só nos `days`) a essa hora local. Dias: 0 = segunda … 6 = domingo; vazio
    /// = todos.
    Daily { hour: u32, minute: u32, #[serde(default)] days: Vec<u8> },
    /// Uma vez, nesse instante (segundos unix).
    Once { at: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    pub text: String,
    /// A tab que recebe o texto. `None` = um lembrete para o usuário.
    pub target_tab: Option<String>,
    /// O nome dela, para mostrar (a tab pode já não existir).
    pub target_name: String,
    /// Quem a criou: é quem a gerencia.
    pub creator: String,
    pub schedule: Schedule,
    pub enabled: bool,
    pub next_run: Option<i64>,
    pub last_run: Option<i64>,
    pub last_result: String,
    pub runs: u64,
}

// ── Horários ────────────────────────────────────────────────────────

/// `30m`, `2h`, `1d`, `90s` → segundos.
pub fn parse_duration(raw: &str) -> Result<i64, String> {
    let raw = raw.trim().to_lowercase();
    let (digits, unit) = raw.split_at(raw.find(|c: char| !c.is_ascii_digit()).unwrap_or(raw.len()));
    let n: i64 = digits.parse().map_err(|_| format!("'{raw}' não é uma duração: use 30m, 2h ou 1d."))?;
    let mult = match unit {
        "s" => 1,
        "m" | "min" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return Err(format!("'{raw}' não é uma duração: use 30m, 2h ou 1d.")),
    };
    n.checked_mul(mult).filter(|s| *s > 0).ok_or_else(|| format!("'{raw}' não é uma duração válida."))
}

/// `09:00`, `9:30`, `18` → (hora, minuto).
pub fn parse_time(raw: &str) -> Result<(u32, u32), String> {
    let raw = raw.trim();
    let (h, m) = raw.split_once(':').unwrap_or((raw, "0"));
    let hour: u32 = h.parse().map_err(|_| format!("'{raw}' não é um horário: use 09:00."))?;
    let minute: u32 = m.parse().map_err(|_| format!("'{raw}' não é um horário: use 09:00."))?;
    if hour > 23 || minute > 59 {
        return Err(format!("'{raw}' não é um horário válido (00:00 a 23:59)."));
    }
    Ok((hour, minute))
}

/// `seg,qua,sex` / `mon,wed` → dias (0 = segunda). Aceita português e inglês.
pub fn parse_days(raw: &str) -> Result<Vec<u8>, String> {
    let mut days = BTreeSet::new();
    for part in raw.split(',').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()) {
        let day = match part.as_str() {
            "seg" | "mon" | "segunda" | "monday" => 0,
            "ter" | "tue" | "terca" | "terça" | "tuesday" => 1,
            "qua" | "wed" | "quarta" | "wednesday" => 2,
            "qui" | "thu" | "quinta" | "thursday" => 3,
            "sex" | "fri" | "sexta" | "friday" => 4,
            "sab" | "sat" | "sábado" | "sabado" | "saturday" => 5,
            "dom" | "sun" | "domingo" | "sunday" => 6,
            other => return Err(format!("'{other}' não é um dia: use seg,ter,qua,qui,sex,sab,dom.")),
        };
        days.insert(day);
    }
    if days.is_empty() {
        return Err("--days está vazio: diga os dias (seg,qua,sex).".into());
    }
    Ok(days.into_iter().collect())
}

/// Monta o horário a partir do que veio da linha de comandos: exatamente UM entre `every`,
/// `at` e `in_`. `days` só vale com `at`.
pub fn build_schedule(
    every: Option<&str>,
    at: Option<&str>,
    days: Option<&str>,
    in_: Option<&str>,
    now: DateTime<Local>,
) -> Result<Schedule, String> {
    let given = [every.is_some(), at.is_some(), in_.is_some()].iter().filter(|g| **g).count();
    if given != 1 {
        return Err("Diga quando: --every 30m (repete), --at 09:00 [--days seg,qua] (todo dia) ou --in 45m (uma vez).".into());
    }
    if days.is_some() && at.is_none() {
        return Err("--days só vale com --at.".into());
    }
    if let Some(e) = every {
        let secs = parse_duration(e)?;
        if secs < MIN_EVERY_SECS {
            return Err("O intervalo mínimo é de 5 minutos (--every 5m).".into());
        }
        return Ok(Schedule::Every { secs });
    }
    if let Some(a) = at {
        let (hour, minute) = parse_time(a)?;
        let days = days.map(parse_days).transpose()?.unwrap_or_default();
        return Ok(Schedule::Daily { hour, minute, days });
    }
    let secs = parse_duration(in_.unwrap_or_default())?;
    if secs < MIN_IN_SECS {
        return Err("O prazo mínimo é de 1 minuto (--in 1m).".into());
    }
    Ok(Schedule::Once { at: (now + Duration::seconds(secs)).timestamp() })
}

/// A próxima vez, estritamente depois de `after`. `None` = não volta a acontecer.
pub fn next_run(schedule: &Schedule, after: DateTime<Local>) -> Option<DateTime<Local>> {
    match schedule {
        Schedule::Every { secs } => Some(after + Duration::seconds(*secs)),
        Schedule::Once { at } => (*at > after.timestamp()).then(|| Local.timestamp_opt(*at, 0).single()).flatten(),
        Schedule::Daily { hour, minute, days } => {
            let time = NaiveTime::from_hms_opt(*hour, *minute, 0)?;
            // Uma semana e um dia de folga: cobre qualquer combinação de dias, e um dia
            // que a hora de verão apague.
            (0..=8).find_map(|offset| {
                let date = after.date_naive() + Duration::days(offset);
                let on_day = days.is_empty() || days.contains(&(date.weekday().num_days_from_monday() as u8));
                if !on_day {
                    return None;
                }
                let candidate = Local.from_local_datetime(&date.and_time(time)).earliest()?;
                (candidate > after).then_some(candidate)
            })
        }
    }
}

/// Para mostrar: "a cada 30 min", "todo dia às 09:00 (seg, qua)", "uma vez".
pub fn describe(schedule: &Schedule) -> String {
    match schedule {
        Schedule::Every { secs } if secs % 3600 == 0 => format!("a cada {} h", secs / 3600),
        Schedule::Every { secs } if secs % 60 == 0 => format!("a cada {} min", secs / 60),
        Schedule::Every { secs } => format!("a cada {secs} s"),
        Schedule::Once { .. } => "uma vez".to_string(),
        Schedule::Daily { hour, minute, days } => {
            let when = format!("às {hour:02}:{minute:02}");
            if days.is_empty() {
                format!("todo dia {when}")
            } else {
                const NAMES: [&str; 7] = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
                let list: Vec<_> = days.iter().filter_map(|d| NAMES.get(*d as usize)).copied().collect();
                format!("{when} ({})", list.join(", "))
            }
        }
    }
}

// ── Validações ──────────────────────────────────────────────────────

/// Achata o texto: uma linha, sem caracteres de controle, no limite. Um agente que o
/// escreveu não pode, por exemplo, embutir uma sequência de escape que o terminal
/// interprete.
pub fn clean_text(raw: &str) -> Result<String, String> {
    let flat: String = raw.chars().map(|c| if c == '\n' || c == '\t' { ' ' } else { c }).filter(|c| !c.is_control()).collect();
    let text = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("A rotina precisa de um texto: o que ela deve dizer.".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("O texto passa de {MAX_TEXT} caracteres: resuma, ou ponha o detalhe numa nota."));
    }
    Ok(text)
}

pub fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("A rotina precisa de um nome.".into());
    }
    if name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(format!("O nome da rotina tem até {MAX_NAME} caracteres e não leva caracteres de controle."));
    }
    Ok(name)
}

/// Acha uma rotina por nome (sem maiúsculas) ou id. Um nome que dá em duas é um erro.
pub fn find<'a>(routines: &'a [Routine], wanted: &str) -> Result<&'a Routine, String> {
    if let Some(r) = routines.iter().find(|r| r.id == wanted) {
        return Ok(r);
    }
    let needle = wanted.trim().to_lowercase();
    let matches: Vec<&Routine> = routines.iter().filter(|r| r.name.to_lowercase() == needle).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "Não existe a rotina '{wanted}'. {}",
            if routines.is_empty() {
                "Você não tem nenhuma: crie com `ccode routine create`.".to_string()
            } else {
                format!("Rotinas: {}.", routines.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", "))
            }
        )),
        many => Err(format!("Há {} rotinas chamadas '{wanted}'. Use o id: {}", many.len(), many.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

/// Ao abrir a app: nada do que se perdeu volta a rodar (ver o módulo). Recalcula a próxima
/// vez a partir de agora; um lembrete único atrasado fica desligado e marcado.
pub fn recover(routines: &mut [Routine], now: DateTime<Local>) -> bool {
    let mut changed = false;
    for r in routines.iter_mut().filter(|r| r.enabled) {
        let overdue = r.next_run.is_some_and(|n| n <= now.timestamp());
        if !overdue {
            continue;
        }
        changed = true;
        match r.schedule {
            Schedule::Once { .. } => {
                r.enabled = false;
                r.next_run = None;
                r.last_result = "perdida: a app estava fechada na hora".into();
            }
            _ => r.next_run = next_run(&r.schedule, now).map(|t| t.timestamp()),
        }
    }
    changed
}

/// Registra que a rotina acabou de rodar (ou tentou) e calcula a seguinte.
pub fn after_run(r: &mut Routine, now: DateTime<Local>, result: String) {
    r.last_run = Some(now.timestamp());
    r.last_result = result;
    r.runs += 1;
    match r.schedule {
        Schedule::Once { .. } => {
            r.enabled = false;
            r.next_run = None;
        }
        _ => r.next_run = next_run(&r.schedule, now).map(|t| t.timestamp()),
    }
}

/// As que já passaram da hora.
pub fn due(routines: &[Routine], now: i64) -> Vec<String> {
    routines
        .iter()
        .filter(|r| r.enabled && r.next_run.is_some_and(|n| n <= now))
        .map(|r| r.id.clone())
        .collect()
}

// ── Arquivo ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct RoutinesFile {
    #[serde(default)]
    routines: Vec<Routine>,
}

lazy_static::lazy_static! {
    /// Lê-modifica-escreve: o agendador e os comandos mexem no mesmo arquivo.
    static ref LOCK: Mutex<()> = Mutex::new(());
}

fn file_path() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("Não foi possível achar a pasta do usuário")?.join(".controlcode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("routines.json"))
}

fn read_file() -> Vec<Routine> {
    let Ok(path) = file_path() else { return Vec::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RoutinesFile>(&raw).ok())
        .map(|f| f.routines)
        .unwrap_or_default()
}

fn write_file(routines: &[Routine]) -> Result<(), String> {
    let path = file_path()?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&RoutinesFile { routines: routines.to_vec() }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn all() -> Vec<Routine> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_file()
}

/// Lê, aplica `change` e guarda, tudo sob o mesmo cadeado. Devolve o que `change` devolva.
pub fn update<T>(change: impl FnOnce(&mut Vec<Routine>) -> Result<T, String>) -> Result<T, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut routines = read_file();
    let out = change(&mut routines)?;
    write_file(&routines)?;
    Ok(out)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

#[cfg(test)]
mod test;
