use super::*;
use std::collections::VecDeque;

fn observation(revision: &str, text: &str) -> Observation {
    Observation {
        revision: revision.into(),
        text: text.into(),
        safe_for_provider: true,
        targets: vec![Target {
            id: "e1".into(),
            label: "Abrir detalhes".into(),
            operations: vec![Operation::Click, Operation::Type],
            risk: Risk::Ordinary,
        }],
    }
}
fn request() -> Request {
    Request {
        goal: "abrir detalhes".into(),
        fills: BTreeMap::new(),
        expect: vec!["DETALHES ABERTOS".into()],
        steps: 3,
    }
}
fn decision(operation: Operation) -> Decision {
    Decision {
        requires_confirmation: false,
        action: Action {
            operation,
            target: Some("e1".into()),
        },
        probability: 0.9,
        goal_done: Some(0.9),
    }
}
struct Mock {
    observations: VecDeque<Observation>,
    decisions: VecDeque<Decision>,
    approved: bool,
    confirmations: usize,
    executions: usize,
    authorizations: usize,
    values: Vec<String>,
    sent: Vec<String>,
    stale: bool,
    fail_execute: bool,
    denied: bool,
    deny_on_confirm: bool,
    deny_on_observe: bool,
}
impl Mock {
    fn new(observations: Vec<Observation>, decisions: Vec<Decision>) -> Self {
        Self {
            observations: observations.into(),
            decisions: decisions.into(),
            approved: true,
            confirmations: 0,
            executions: 0,
            authorizations: 0,
            values: vec![],
            sent: vec![],
            stale: false,
            fail_execute: false,
            denied: false,
            deny_on_confirm: false,
            deny_on_observe: false,
        }
    }
}
impl Surface for Mock {
    fn authorize(&mut self) -> Result<(), Failure> {
        self.authorizations += 1;
        if self.denied {
            Err(Failure::AccessibilityPermission)
        } else {
            Ok(())
        }
    }
    fn observe(&mut self) -> Result<Observation, String> {
        self.denied |= self.deny_on_observe;
        self.observations
            .pop_front()
            .ok_or("sem observações".into())
    }
    fn confirm(&mut self, _: &str, _: &Action) -> Result<bool, String> {
        self.confirmations += 1;
        self.denied |= self.deny_on_confirm;
        Ok(self.approved)
    }
    fn execute(&mut self, _: &str, _: &Action, value: Option<&str>) -> Result<bool, String> {
        self.executions += 1;
        if let Some(value) = value {
            self.values.push(value.into());
        }
        if self.fail_execute {
            Err("valor-secreto-na-excecao".into())
        } else {
            Ok(!self.stale)
        }
    }
}
struct Model {
    inner: Mock,
}
impl Decider for Model {
    fn decide(
        &mut self,
        goal: &str,
        observation: &Observation,
        actions: &[Action],
    ) -> Result<Decision, String> {
        self.inner
            .sent
            .push(format!("{goal} {} {actions:?}", observation.text));
        self.inner
            .decisions
            .pop_front()
            .ok_or("sem decisões".into())
    }
}
fn model(decisions: Vec<Decision>) -> Model {
    Model {
        inner: Mock::new(vec![], decisions),
    }
}

#[test]
fn observa_age_e_verifica_por_estado_inclusive_no_ultimo_passo() {
    let mut req = request();
    req.steps = 1;
    let mut driver = Mock::new(
        vec![
            observation("a", "início"),
            observation("b", "DETALHES ABERTOS"),
        ],
        vec![],
    );
    let report = run(
        &req,
        &mut driver,
        &mut model(vec![decision(Operation::Click)]),
    );
    assert_eq!(report.status, Status::Done);
    assert_eq!(
        (report.queries, report.observations, driver.executions),
        (1, 2, 1)
    );
    assert_eq!(driver.confirmations, 0);
}
#[test]
fn expectativa_ja_satisfeita_nao_gasta_jev_nem_age() {
    let mut driver = Mock::new(vec![observation("a", "DETALHES ABERTOS")], vec![]);
    let report = run(&request(), &mut driver, &mut model(vec![]));
    assert_eq!(report.status, Status::Done);
    assert_eq!((report.queries, driver.executions), (0, 0));
}
#[test]
fn conclusao_do_modelo_nao_substitui_expectativa() {
    let mut driver = Mock::new(vec![observation("a", "ainda na home")], vec![]);
    assert_eq!(
        run(
            &request(),
            &mut driver,
            &mut model(vec![decision(Operation::Done)])
        )
        .status,
        Status::Unsure
    );
    let mut req = request();
    req.expect.clear();
    let mut driver = Mock::new(vec![observation("a", "home")], vec![]);
    assert_eq!(
        run(
            &req,
            &mut driver,
            &mut model(vec![decision(Operation::Done)])
        )
        .status,
        Status::Unverified
    );
}
#[test]
fn texto_digitado_fica_local_e_nunca_vai_ao_modelo_ou_relatorio() {
    let mut req = request();
    req.fills.insert("e1".into(), "segredo-local-123".into());
    let mut driver = Mock::new(
        vec![
            observation("a", "campo vazio"),
            observation("b", "DETALHES ABERTOS"),
        ],
        vec![],
    );
    let mut jev = model(vec![decision(Operation::Type)]);
    let report = run(&req, &mut driver, &mut jev);
    assert_eq!(report.status, Status::Done);
    assert_eq!(driver.values, ["segredo-local-123"]);
    assert!(!jev.inner.sent.join(" ").contains("segredo-local"));
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("segredo-local")
    );
}
#[test]
fn nao_inventa_texto_quando_nao_ha_fill() {
    let mut driver = Mock::new(vec![observation("a", "campo vazio")], vec![]);
    assert_eq!(
        run(
            &request(),
            &mut driver,
            &mut model(vec![decision(Operation::Type)])
        )
        .status,
        Status::Blocked
    );
    assert_eq!(driver.executions, 0);
}
#[test]
fn sensivel_ou_desconhecido_exige_confirmacao_e_recusa_nao_age() {
    for (risk, label) in [
        (Risk::Sensitive, "continuar"),
        (Risk::Unknown, "ícone"),
        (Risk::Ordinary, "Enviar"),
        (Risk::Ordinary, "Comprar"),
        (Risk::Ordinary, "Apagar"),
        (Risk::Ordinary, "Password"),
        (Risk::Ordinary, "Sign out"),
    ] {
        let mut obs = observation("a", "tela");
        obs.targets[0].risk = risk;
        obs.targets[0].label = label.into();
        let mut driver = Mock::new(vec![obs], vec![]);
        driver.approved = false;
        let report = run(
            &request(),
            &mut driver,
            &mut model(vec![decision(Operation::Click)]),
        );
        assert_eq!(report.status, Status::Blocked, "{label}");
        assert_eq!((driver.confirmations, driver.executions), (1, 0));
    }
}
#[test]
fn acao_aprovada_ainda_revalida_autorizacao_e_revisao() {
    let mut obs = observation("a", "tela");
    obs.targets[0].risk = Risk::Sensitive;
    let mut driver = Mock::new(vec![obs, observation("b", "DETALHES ABERTOS")], vec![]);
    assert_eq!(
        run(
            &request(),
            &mut driver,
            &mut model(vec![decision(Operation::Click)])
        )
        .status,
        Status::Done
    );
    assert_eq!(
        (
            driver.confirmations,
            driver.executions,
            driver.authorizations
        ),
        (1, 1, 6)
    );
}
#[test]
fn revisao_desatualizada_nao_registra_mutacao_e_reobserva() {
    let mut req = request();
    req.steps = 1;
    let mut driver = Mock::new(
        vec![observation("a", "tela"), observation("b", "tela nova")],
        vec![],
    );
    driver.stale = true;
    let report = run(
        &req,
        &mut driver,
        &mut model(vec![decision(Operation::Click)]),
    );
    assert_eq!((report.status, report.observations), (Status::Limit, 2));
    assert!(report.actions.is_empty());
}
#[test]
fn falha_de_transporte_nao_repete_mutacao_e_preserva_tentativa_sem_segredo() {
    let mut driver = Mock::new(vec![observation("a", "tela")], vec![]);
    driver.fail_execute = true;
    let report = run(
        &request(),
        &mut driver,
        &mut model(vec![decision(Operation::Click)]),
    );
    assert_eq!(report.status, Status::Blocked);
    assert_eq!(report.actions.len(), 1);
    assert_eq!(driver.executions, 1);
    assert!(!report.reason.contains("valor-secreto"));
}
#[test]
fn nao_repete_acao_na_mesma_tela() {
    let mut driver = Mock::new(
        vec![observation("a", "tela"), observation("a", "tela")],
        vec![],
    );
    let report = run(
        &request(),
        &mut driver,
        &mut model(vec![decision(Operation::Click), decision(Operation::Click)]),
    );
    assert_eq!(report.status, Status::Stuck);
    assert_eq!(driver.executions, 1);
}
#[test]
fn privacidade_desconhecida_bloqueia_antes_do_provedor() {
    let mut obs = observation("a", "conteúdo local");
    obs.safe_for_provider = false;
    let mut driver = Mock::new(vec![obs], vec![]);
    let report = run(&request(), &mut driver, &mut model(vec![]));
    assert_eq!((report.status, report.queries), (Status::Blocked, 0));
}
#[test]
fn permissoes_negadas_impedem_observacao() {
    let mut driver = Mock::new(vec![], vec![]);
    driver.denied = true;
    let report = run(&request(), &mut driver, &mut model(vec![]));
    assert_eq!(
        (report.status, report.observations, report.queries),
        (Status::Blocked, 0, 0)
    );
}
#[test]
fn alvo_inventado_ou_probabilidade_invalida_nao_age() {
    for (id, p, expected) in [
        ("fora", 0.9, Status::Blocked),
        ("e1", f64::NAN, Status::Unsure),
        ("e1", 1.1, Status::Unsure),
        ("e1", 0.39, Status::Unsure),
    ] {
        let mut choice = decision(Operation::Click);
        choice.action.target = Some(id.into());
        choice.probability = p;
        let mut driver = Mock::new(vec![observation("a", "tela")], vec![]);
        assert_eq!(
            run(&request(), &mut driver, &mut model(vec![choice])).status,
            expected
        );
        assert_eq!(driver.executions, 0);
    }
}
#[test]
fn orcamento_invalido_e_expectativa_vazia_nao_observam() {
    for steps in [0, 16, usize::MAX] {
        let mut req = request();
        req.steps = steps;
        let mut driver = Mock::new(vec![], vec![]);
        assert_eq!(run(&req, &mut driver, &mut model(vec![])).observations, 0);
    }
    let mut req = request();
    req.expect = vec!["".into()];
    assert_eq!(
        run(&req, &mut Mock::new(vec![], vec![]), &mut model(vec![])).observations,
        0
    );
}
#[test]
fn ids_duplicados_ou_nao_tipados_nao_chegam_ao_modelo() {
    for id in ["e1", "$(comando)"] {
        let mut obs = observation("a", "tela");
        let mut target = obs.targets[0].clone();
        target.id = id.into();
        obs.targets.push(target);
        let report = run(
            &request(),
            &mut Mock::new(vec![obs], vec![]),
            &mut model(vec![]),
        );
        assert_eq!((report.status, report.queries), (Status::Blocked, 0));
    }
}

#[test]
fn segredo_no_objetivo_ou_na_arvore_bloqueia_sem_consulta() {
    let secret = "password: hunter2";
    let mut req = request();
    req.goal = secret.into();
    let report = run(&req, &mut Mock::new(vec![], vec![]), &mut model(vec![]));
    assert_eq!(
        (report.status, report.queries, report.observations),
        (Status::Blocked, 0, 0)
    );
    let mut obs = observation("a", "tela");
    obs.targets[0].label = secret.into();
    let report = run(
        &request(),
        &mut Mock::new(vec![obs], vec![]),
        &mut model(vec![]),
    );
    assert_eq!((report.status, report.queries), (Status::Blocked, 0));
}

#[test]
fn mensagens_de_permissao_sao_claras_sem_dados_da_tela() {
    assert!(
        Failure::AccessibilityPermission
            .message()
            .contains("Acessibilidade")
    );
    assert!(
        Failure::ScreenRecordingPermission
            .message()
            .contains("Gravação de Tela")
    );
    assert!(Failure::OutsideScope.message().contains("canvas"));
}

#[test]
fn revogar_permissao_durante_confirmacao_impede_execucao() {
    let mut obs = observation("a", "tela");
    obs.targets[0].risk = Risk::Sensitive;
    let mut driver = Mock::new(vec![obs], vec![]);
    driver.deny_on_confirm = true;
    let report = run(
        &request(),
        &mut driver,
        &mut model(vec![decision(Operation::Click)]),
    );
    assert_eq!(report.status, Status::Blocked);
    assert_eq!((driver.confirmations, driver.executions), (1, 0));
    assert!(report.reason.contains("Acessibilidade"));
}

#[test]
fn ciclo_entre_telas_nao_repete_mutacao_ja_tentada() {
    let mut driver = Mock::new(
        vec![
            observation("a", "A"),
            observation("b", "B"),
            observation("a", "A"),
        ],
        vec![],
    );
    let mut jev = model(vec![
        decision(Operation::Click),
        decision(Operation::Click),
        decision(Operation::Click),
    ]);
    let report = run(&request(), &mut driver, &mut jev);
    assert_eq!(report.status, Status::Stuck);
    assert_eq!(driver.executions, 2);
}

#[test]
fn decisor_so_pode_elevar_risco_e_pedir_confirmacao_humana() {
    let mut choice = decision(Operation::Click);
    choice.requires_confirmation = true;
    let mut driver = Mock::new(vec![observation("a", "tela")], vec![]);
    driver.approved = false;
    let report = run(&request(), &mut driver, &mut model(vec![choice]));
    assert_eq!(
        (report.status, driver.confirmations, driver.executions),
        (Status::Blocked, 1, 0)
    );
}

#[test]
fn revogar_durante_observacao_impede_enviar_foto_ao_decisor() {
    let mut driver = Mock::new(vec![observation("a", "tela")], vec![]);
    driver.deny_on_observe = true;
    let report = run(&request(), &mut driver, &mut model(vec![]));
    assert_eq!((report.status, report.queries), (Status::Blocked, 0));
}

#[test]
fn fill_repetido_no_objetivo_e_redigido_antes_do_decisor() {
    let mut req = request();
    req.goal = "digite laranja no campo".into();
    req.fills.insert("e1".into(), "laranja".into());
    let mut driver = Mock::new(
        vec![
            observation("a", "campo vazio"),
            observation("b", "DETALHES ABERTOS"),
        ],
        vec![],
    );
    let mut jev = model(vec![decision(Operation::Type)]);
    let report = run(&req, &mut driver, &mut jev);
    assert_eq!(report.status, Status::Done);
    assert!(!jev.inner.sent.join(" ").contains("laranja"));
    assert!(jev.inner.sent[0].contains("[valor local]"));
}
