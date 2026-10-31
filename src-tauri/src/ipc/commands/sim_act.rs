//! `ags sim act`: mesma identidade/alcance do device, com visão e HID no simulador iOS.
use crate::{
    computer_use::{self, Request},
    ipc::protocol::{arg_str, arg_u64_checked},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tauri::AppHandle;

fn list(args: &Value, key: &str) -> Result<Vec<String>, String> {
    match args.get(key) {
        None => Ok(vec![]),
        Some(Value::String(v)) => Ok(vec![v.clone()]),
        Some(Value::Array(v)) => v
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("--{key} exige texto."))
            })
            .collect(),
        _ => Err(format!("--{key} exige texto.")),
    }
}
pub(super) fn parse(args: &Value) -> Result<(Request, Duration), String> {
    let goal = arg_str(args, "goal")?;
    if goal.trim().is_empty() {
        return Err("Informe o objetivo.".into());
    }
    let steps = arg_u64_checked(args, "steps")?.unwrap_or(8);
    if !(1..=15).contains(&steps) {
        return Err("--steps precisa estar entre 1 e 15.".into());
    }
    let seconds = arg_u64_checked(args, "timeout")?.unwrap_or(115);
    if !(10..=1800).contains(&seconds) {
        return Err("--timeout precisa estar entre 10 e 1800 segundos.".into());
    }
    let mut fills = BTreeMap::new();
    for fill in list(args, "fill")? {
        let (field, value) = fill
            .split_once('=')
            .ok_or("--fill precisa ser screen=valor (campo já focado).")?;
        if value.is_empty()
            || value.chars().any(char::is_control)
            || crate::simulator::model::text_keys(value).is_err()
        {
            return Err("--fill exige texto ASCII não vazio, sem Enter, Tab ou controles; este HID usa o teclado US.".into());
        }
        if field != "screen" || fills.insert(field.into(), value.into()).is_some() {
            return Err(
                "No iOS visual use um único --fill screen=valor, para o campo já focado.".into(),
            );
        }
    }
    let mut expect = vec![];
    for value in list(args, "expect")? {
        let text=value.strip_prefix("text:").filter(|s|!s.trim().is_empty()).ok_or("O iOS visual aceita --expect text:trecho (OCR local); url/count/absent exigem acessibilidade.")?;
        expect.push(text.into());
    }
    Ok((
        Request {
            goal,
            fills,
            expect,
            steps: steps as usize,
        },
        Duration::from_secs(seconds),
    ))
}

pub(super) fn act(app: &AppHandle, args: &Value) -> Result<Value, String> {
    // Parser e escopo vêm antes de captura ou consulta paga.
    let (request, timeout) = parse(args)?;
    let session = arg_str(args, "session")
        .map_err(|_| "sim act exige a sessão de um terminal ADE AGS.".to_string())?;
    let client_pid = crate::ipc::current_client_pid();
    let from = crate::terminal::authorize(
        Some(&session),
        args.get("from").and_then(Value::as_str),
        client_pid,
    )?;
    let (node, udid) = super::devices::ios_target(&from, &arg_str(args, "name")?)?;
    let db = super::shared::db(app)?.inner().clone();
    let report = computer_use::ios::act(
        app,
        db,
        computer_use::ios::Caller {
            tab: from.clone(),
            session,
            client_pid,
        },
        &node,
        &udid,
        &request,
        timeout,
    )?;
    super::simulators::act_activity(app, &node, &from, &report);
    let text = format!(
        "{}\nAções tentadas: {}. Observações: {}. Chamadas ao decisor: {}.",
        report.reason,
        report.actions.len(),
        report.observations,
        report.queries
    );
    Ok(json!({"simulator":{"id":node,"udid":udid},"text":text,"report":report}))
}

#[cfg(test)]
mod test {
    use super::*;
    #[test]
    fn aceita_fill_local_expectativas_e_orcamentos_sem_perder_igual() {
        let (q,t)=parse(&json!({"goal":"preencher busca","fill":"screen=a=b","expect":["text:Resultado","text:Busca"],"steps":"3","timeout":"60"})).unwrap();
        assert_eq!(q.fills["screen"], "a=b");
        assert_eq!(q.expect, ["Resultado", "Busca"]);
        assert_eq!(q.steps, 3);
        assert_eq!(t.as_secs(), 60);
    }
    #[test]
    fn rejeita_uso_invalido_antes_de_observar() {
        for args in [
            json!({"goal":"x","fill":"senha=x"}),
            json!({"goal":"x","fill":"screen=linha\nEnter"}),
            json!({"goal":"x","fill":"screen=acentuação"}),
            json!({"goal":"x","fill":"screen="}),
            json!({"goal":"x","fill":["screen=x","screen=y"]}),
            json!({"goal":"x","expect":"url:/home"}),
            json!({"goal":"x","expect":"text:"}),
            json!({"goal":"x","steps":16}),
            json!({"goal":"x","timeout":0}),
            json!({"goal":"x","expect":[true]}),
            json!({"goal":""}),
        ] {
            assert!(parse(&args).is_err(), "{args}");
        }
    }
}
