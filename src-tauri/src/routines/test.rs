use super::*;

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
    Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap()
}

// 2026-10-05 é uma segunda-feira.
fn monday_noon() -> DateTime<Local> {
    at(2026, 10, 5, 12, 0)
}

fn routine(schedule: Schedule, next: Option<DateTime<Local>>) -> Routine {
    Routine {
        id: "r1".into(),
        name: "Testes".into(),
        text: "rode os testes".into(),
        target_tab: Some("t1".into()),
        target_name: "Backend".into(),
        creator: "t1".into(),
        schedule,
        enabled: true,
        next_run: next.map(|t| t.timestamp()),
        last_run: None,
        last_result: String::new(),
        runs: 0,
        catch_up: false,
        missed_at: None,
    }
}

#[test]
fn le_duraciones_y_rechaza_lo_que_no_lo_es() {
    assert_eq!(parse_duration("30m").unwrap(), 1800);
    assert_eq!(parse_duration("2h").unwrap(), 7200);
    assert_eq!(parse_duration(" 1D ").unwrap(), 86_400);
    assert_eq!(parse_duration("90s").unwrap(), 90);
    for bad in ["", "m", "10", "10x", "-5m", "0m", "1.5h"] {
        assert!(parse_duration(bad).is_err(), "{bad}");
    }
}

#[test]
fn le_horarios_y_dias() {
    assert_eq!(parse_time("09:00").unwrap(), (9, 0));
    assert_eq!(parse_time("9:30").unwrap(), (9, 30));
    assert_eq!(parse_time("18").unwrap(), (18, 0));
    assert!(parse_time("24:00").is_err());
    assert!(parse_time("9:60").is_err());
    assert!(parse_time("cedo").is_err());
    assert_eq!(parse_days("seg, qua,SEX").unwrap(), vec![0, 2, 4]);
    assert_eq!(parse_days("sun,mon").unwrap(), vec![0, 6], "inglês, sin repetidos y ordenado");
    assert!(parse_days("lunes").is_err());
    assert!(parse_days(" , ").is_err());
}

#[test]
fn exige_exactamente_un_cuando() {
    let now = monday_noon();
    assert!(build_schedule(None, None, None, None, now).is_err());
    assert!(build_schedule(Some("10m"), Some("09:00"), None, None, now).is_err());
    assert!(build_schedule(Some("10m"), None, None, Some("5m"), now).is_err());
    assert_eq!(build_schedule(Some("30m"), None, None, None, now).unwrap(), Schedule::Every { secs: 1800 });
    assert_eq!(
        build_schedule(None, Some("09:00"), Some("seg,qua"), None, now).unwrap(),
        Schedule::Daily { hour: 9, minute: 0, days: vec![0, 2] }
    );
    assert_eq!(
        build_schedule(None, None, None, Some("45m"), now).unwrap(),
        Schedule::Once { at: now.timestamp() + 2700 }
    );
}

#[test]
fn los_limites_protegen_de_una_rutina_que_se_manda_mensajes_sin_parar() {
    let now = monday_noon();
    assert!(build_schedule(Some("4m"), None, None, None, now).unwrap_err().contains("5 minutos"));
    assert!(build_schedule(Some("5m"), None, None, None, now).is_ok());
    assert!(build_schedule(None, None, None, Some("30s"), now).is_err());
    assert!(build_schedule(None, Some("09:00"), None, Some("5m"), now).is_err());
    assert!(build_schedule(Some("10m"), None, Some("seg"), None, now).unwrap_err().contains("--at"));
}

#[test]
fn a_cada_intervalo_cuenta_desde_la_ultima_vez() {
    let next = next_run(&Schedule::Every { secs: 600 }, monday_noon()).unwrap();
    assert_eq!(next, monday_noon() + Duration::minutes(10));
}

#[test]
fn diaria_elige_hoy_si_aun_no_paso_y_manana_si_ya_paso() {
    let daily = Schedule::Daily { hour: 15, minute: 30, days: vec![] };
    assert_eq!(next_run(&daily, monday_noon()).unwrap(), at(2026, 10, 5, 15, 30));
    assert_eq!(next_run(&daily, at(2026, 10, 5, 15, 30)).unwrap(), at(2026, 10, 6, 15, 30), "estrictamente después");
    assert_eq!(next_run(&daily, at(2026, 10, 5, 20, 0)).unwrap(), at(2026, 10, 6, 15, 30));
}

#[test]
fn diaria_con_dias_salta_a_el_proximo_que_toca() {
    let mon_wed = Schedule::Daily { hour: 9, minute: 0, days: vec![0, 2] };
    // Lunes al mediodía: el lunes de las 9 ya pasó, la siguiente es el miércoles.
    assert_eq!(next_run(&mon_wed, monday_noon()).unwrap(), at(2026, 10, 7, 9, 0));
    // Miércoles tarde: la siguiente es el lunes que viene.
    assert_eq!(next_run(&mon_wed, at(2026, 10, 7, 10, 0)).unwrap(), at(2026, 10, 12, 9, 0));
    // Solo domingos, desde el lunes.
    let sun = Schedule::Daily { hour: 8, minute: 0, days: vec![6] };
    assert_eq!(next_run(&sun, monday_noon()).unwrap(), at(2026, 10, 11, 8, 0));
}

#[test]
fn una_vez_no_vuelve() {
    let once = Schedule::Once { at: (monday_noon() + Duration::hours(1)).timestamp() };
    assert_eq!(next_run(&once, monday_noon()).unwrap(), monday_noon() + Duration::hours(1));
    assert!(next_run(&once, monday_noon() + Duration::hours(2)).is_none());
}

#[test]
fn describe_cada_horario() {
    assert_eq!(describe(&Schedule::Every { secs: 1800 }), "a cada 30 min");
    assert_eq!(describe(&Schedule::Every { secs: 7200 }), "a cada 2 h");
    assert_eq!(describe(&Schedule::Daily { hour: 9, minute: 5, days: vec![] }), "todo dia às 09:05");
    assert_eq!(describe(&Schedule::Daily { hour: 9, minute: 0, days: vec![0, 4] }), "às 09:00 (seg, sex)");
    assert_eq!(describe(&Schedule::Once { at: 1 }), "uma vez");
}

#[test]
fn el_texto_se_aplana_y_se_limita() {
    assert_eq!(clean_text("  rode\n\nos\ttestes \x1b[31m ").unwrap(), "rode os testes [31m");
    assert!(clean_text(" \n ").is_err());
    assert!(clean_text(&"a".repeat(MAX_TEXT + 1)).is_err());
    assert!(clean_name("  ").is_err());
    assert_eq!(clean_name("  Testes   da manhã ").unwrap(), "Testes da manhã");
    assert!(clean_name("a\u{7}b").is_err());
}

#[test]
fn encuentra_por_nombre_o_id_y_el_error_ayuda() {
    let mut other = routine(Schedule::Every { secs: 600 }, None);
    other.id = "r2".into();
    other.name = "Revisão".into();
    let list = vec![routine(Schedule::Every { secs: 600 }, None), other];
    assert_eq!(find(&list, "testes").unwrap().id, "r1");
    assert_eq!(find(&list, "r2").unwrap().name, "Revisão");
    let err = find(&list, "nada").unwrap_err();
    assert!(err.contains("Testes") && err.contains("Revisão"), "{err}");
    assert!(find(&[], "x").unwrap_err().contains("ccode routine create"));
    let dup = vec![routine(Schedule::Every { secs: 600 }, None), routine(Schedule::Every { secs: 600 }, None)];
    assert!(find(&dup, "Testes").unwrap_err().contains("Use o id"));
}

#[test]
fn due_son_las_activas_que_ya_pasaron() {
    let now = monday_noon();
    let mut off = routine(Schedule::Every { secs: 600 }, Some(now - Duration::minutes(1)));
    off.id = "off".into();
    off.enabled = false;
    let mut late = routine(Schedule::Every { secs: 600 }, Some(now - Duration::minutes(1)));
    late.id = "late".into();
    let mut later = routine(Schedule::Every { secs: 600 }, Some(now + Duration::minutes(1)));
    later.id = "later".into();
    assert_eq!(due(&[off, late, later], now.timestamp()), vec!["late".to_string()]);
}

#[test]
fn despues_de_correr_se_agenda_la_siguiente_desde_ahora() {
    let now = monday_noon();
    let mut r = routine(Schedule::Every { secs: 600 }, Some(now - Duration::minutes(25)));
    after_run(&mut r, now, "ok".into());
    assert_eq!(r.next_run, Some((now + Duration::minutes(10)).timestamp()), "sin ráfaga de las que se atrasaron");
    assert_eq!((r.runs, r.last_run, r.enabled), (1, Some(now.timestamp()), true));
}

#[test]
fn una_vez_se_apaga_al_correr() {
    let now = monday_noon();
    let mut r = routine(Schedule::Once { at: now.timestamp() }, Some(now));
    after_run(&mut r, now, "ok".into());
    assert!(!r.enabled && r.next_run.is_none());
}

#[test]
fn al_abrir_no_se_recupera_lo_perdido() {
    let now = monday_noon();
    let mut every = routine(Schedule::Every { secs: 600 }, Some(now - Duration::hours(5)));
    every.id = "every".into();
    let mut once = routine(Schedule::Once { at: (now - Duration::hours(1)).timestamp() }, Some(now - Duration::hours(1)));
    once.id = "once".into();
    let mut fine = routine(Schedule::Every { secs: 600 }, Some(now + Duration::minutes(3)));
    fine.id = "fine".into();
    let mut list = vec![every, once, fine];

    assert!(recover(&mut list, now));
    assert_eq!(list[0].next_run, Some((now + Duration::minutes(10)).timestamp()), "no corre 30 veces de golpe");
    assert_eq!(list[0].runs, 0);
    assert!(!list[1].enabled && list[1].last_result.contains("perdida"));
    assert_eq!(list[2].next_run, Some((now + Duration::minutes(3)).timestamp()), "lo que no se atrasó no se toca");
    assert!(!recover(&mut list, now), "segunda vez, nada que arreglar");
}

#[test]
fn el_archivo_conserva_el_horario_con_su_forma() {
    let r = routine(Schedule::Daily { hour: 9, minute: 0, days: vec![0, 4] }, None);
    let json = serde_json::to_string(&r).unwrap();
    assert!(json.contains("\"kind\":\"daily\"") && json.contains("targetTab"), "{json}");
    let back: Routine = serde_json::from_str(&json).unwrap();
    assert_eq!(back, r);
}

fn recoverable(schedule: Schedule, due: DateTime<Local>) -> Routine {
    let mut r = routine(schedule, Some(due));
    r.catch_up = true;
    r
}

#[test]
fn con_catch_up_una_diaria_perdida_espera_una_sola_recuperacion() {
    let now = monday_noon();
    let missed = now - Duration::hours(3);
    let mut list = vec![recoverable(Schedule::Daily { hour: 9, minute: 0, days: vec![] }, missed)];
    assert!(recover(&mut list, now));
    assert_eq!(list[0].missed_at, Some(missed.timestamp()));
    assert!(list[0].enabled);
    assert!(list[0].next_run.unwrap() > now.timestamp(), "la próxima normal sigue en su hora");
    assert_eq!(pending_catch_up(&list), vec!["r1".to_string()]);
}

#[test]
fn sin_catch_up_o_con_intervalo_o_muy_vieja_no_se_recupera() {
    let now = monday_noon();
    let mut plain = routine(Schedule::Daily { hour: 9, minute: 0, days: vec![] }, Some(now - Duration::hours(3)));
    plain.id = "plain".into();
    let mut every = recoverable(Schedule::Every { secs: 600 }, now - Duration::hours(3));
    every.id = "every".into();
    let mut old = recoverable(Schedule::Daily { hour: 9, minute: 0, days: vec![] }, now - Duration::hours(30));
    old.id = "old".into();
    let mut list = vec![plain, every, old];
    recover(&mut list, now);
    assert!(pending_catch_up(&list).is_empty());
}

#[test]
fn una_unica_recuperable_sigue_encendida_sin_proxima_vez() {
    let now = monday_noon();
    let at = now - Duration::hours(1);
    let mut list = vec![recoverable(Schedule::Once { at: at.timestamp() }, at)];
    recover(&mut list, now);
    assert!(list[0].enabled && list[0].next_run.is_none());
    assert_eq!(list[0].missed_at, Some(at.timestamp()));
    assert!(finish_catch_up(&mut list[0], now, Ok("ok".into()), now.timestamp()));
    assert!(!list[0].enabled && list[0].missed_at.is_none());
    assert!(list[0].last_result.starts_with("recuperada"), "{}", list[0].last_result);
    assert_eq!(list[0].runs, 1);
}

#[test]
fn si_el_destino_no_esta_abierto_se_reintenta_y_pasado_el_plazo_se_desiste() {
    let now = monday_noon();
    let started = now.timestamp();
    let mut r = recoverable(Schedule::Daily { hour: 9, minute: 0, days: vec![] }, now - Duration::hours(3));
    r.missed_at = Some((now - Duration::hours(3)).timestamp());
    assert!(!finish_catch_up(&mut r, now + Duration::minutes(1), Err("aba fechada".into()), started));
    assert!(r.missed_at.is_some(), "sigue esperando");
    assert!(finish_catch_up(&mut r, now + Duration::minutes(16), Err("aba fechada".into()), started));
    assert!(r.missed_at.is_none() && r.last_result.starts_with("perdida"), "{}", r.last_result);
    assert!(r.enabled, "una diaria sigue su horario normal");
}

#[test]
fn correr_en_su_hora_supera_la_recuperacion_pendiente() {
    let now = monday_noon();
    let mut r = routine(Schedule::Daily { hour: 9, minute: 0, days: vec![] }, Some(now));
    r.missed_at = Some(now.timestamp() - 100);
    after_run(&mut r, now, "ok".into());
    assert!(r.missed_at.is_none());
}
