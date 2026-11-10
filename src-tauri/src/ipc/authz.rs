//! Autorização por método do IPC: uma **tabela única** de classes, consultada no começo do despachador (HOST_REMOTO.md, F-09).
//!
//! O token do IPC prova que o chamador é um processo do mesmo usuário, nada mais. Quem separa agentes entre si é o que o
//! servidor consegue **provar** de quem chama (`terminal::principal_of`: o PID do canal de credencial contra a árvore de
//! processos das abas, conversas e tarefas do ADE) e o alcance que o canvas e o registro de "quem abriu" dão a essa identidade.
//!
//! Cada método do despachador tem **uma** classe aqui. Método sem classe é recusado (fecha por padrão) e um teste em
//! `ipc/test.rs` falha se o `match` do despachador ganhar um braço sem entrada.
//!
//! | Classe | O que significa |
//! |---|---|
//! | [`Class::Free`] | só leitura de catálogo, de estado do app ou de metadado: não pede identidade |
//! | [`Class::Scope`] | age sobre um recurso e exige que ele esteja no escopo provado de quem chama (ver [`Target`]) |
//! | [`Class::Person`] | só a pessoa, pela tela: o IPC recusa sempre, como `approval.*` |
//! | [`Class::PersonOrScope`] | a pessoa pela tela **ou** um agente com o papel provado (o orquestrador) |
//!
//! **Limite conhecido.** Quem roda fora de toda árvore de processos do ADE e não declara identidade ([`Principal::Outside`]: a
//! pessoa num terminal próprio, CI) mantém o acesso que sempre teve nos métodos de escopo. O servidor não distingue essa pessoa
//! de um agente que se destacou da árvore (`setsid`, duplo fork, `open -a Terminal`); é o mesmo limite de F-01 e de `tab.send`.

use serde_json::Value;

use crate::canvas::Boards;
use crate::terminal::Principal;

/// Sobre o que um método de escopo age e como o alcance de quem chama é provado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// Uma aba (id em `args[arg]`): é a própria, uma ligada no canvas ou uma que quem chama abriu. Tarefa da Frota não tem aba.
    Tab(&'static str),
    /// Uma conversa do modo chat (id em `args[arg]`, que vira `thread:<id>`), com o mesmo alcance de uma aba. Sem o argumento
    /// (`optional`), só quem roda fora de toda árvore do ADE vê todas; um agente tem de dizer qual.
    Thread { arg: &'static str, optional: bool },
    /// O próprio chamador: o handler resolve portais, aparelhos, notas, pares e equipe pelo canvas dele. Exige aba ou conversa
    /// provada; o `from` provado é entregue ao handler.
    Caller,
    /// Como [`Target::Caller`], mas quem roda fora do app (a pessoa, CI) também serve, sem `from`.
    CallerOrOutside,
    /// Tarefa ou run da Frota, ou a aba que a tarefa serve: o `taskId` (ou `tabId`) declarado tem de ser o provado. Fora, pela pasta.
    Fleet,
    /// Só a tarefa da Frota (as ferramentas de memória da tarefa).
    Task,
    /// Uma missão (id em `args[arg]`): a do quadro de quem chama (e, com `crown`, só o orquestrador dela). Fora (CI): qualquer uma.
    Mission { arg: &'static str, crown: bool },
    /// Nenhum agente: só quem está fora de toda árvore do ADE (a pessoa num terminal próprio, CI). Custa orçamento, apaga
    /// disco ou muda configuração da pessoa, e nenhum fluxo de agente documentado depende disso.
    Outside,
}

/// O papel que a pessoa tem pela tela e um agente só tem se provado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    /// O orquestrador (a coroa no canvas).
    Crown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    Free,
    Scope(Target),
    /// Só a pessoa, pela tela. A mensagem diz por onde.
    Person(&'static str),
    PersonOrScope(Role),
}

use Class::{Free, Person, PersonOrScope, Scope};

const TAB: Class = Scope(Target::Tab("tab"));
const THREAD: Class = Scope(Target::Thread { arg: "thread", optional: false });
const CALLER: Class = Scope(Target::Caller);
const CALLER_OR_OUTSIDE: Class = Scope(Target::CallerOrOutside);
const FLEET: Class = Scope(Target::Fleet);
const TASK: Class = Scope(Target::Task);
const MISSION: Class = Scope(Target::Mission { arg: "mission", crown: false });
const MISSION_CROWN: Class = Scope(Target::Mission { arg: "mission", crown: true });
const OUTSIDE: Class = Scope(Target::Outside);
const CROWN: Class = PersonOrScope(Role::Crown);
const SCREEN_APPROVAL: Class = Person(crate::ipc::APPROVAL_SCREEN_ONLY);
const SCREEN_MAINTENANCE: Class = Person(crate::ipc::AGENT_MAINTENANCE_DENIED);

/// A tabela: método → classe. **Todo** método que o despachador atende (e os que ele recusa antes do `match`) tem uma linha.
pub(crate) const METHODS: &[(&str, Class)] = &[
    // Catálogo e estado do app.
    ("account.list", Free),
    ("agent.list", Free),
    ("app.status", Free),
    ("prelaunch.list", Free),
    ("role.list", Free),
    ("role.show", Free),
    ("skill.list", Free),
    ("skill.search", Free),
    ("skill.show", Free),
    ("pool.list", Free),
    ("window.list", Free),
    ("workspace.list", Free),
    ("workspace.status", Free),
    ("worktrees.list", Free),
    ("chat.providers", Free),
    ("chat.list", Free),
    ("tab.list", Free),
    ("fix.list", Free),
    ("replay.status", Free),
    ("watch.list", Free),
    ("watch.wait", Free),
    ("events.since", Free),
    ("events.wait", Free),
    ("mcp.cancel", Free),
    ("design.list", Free),
    ("design.get", Free),
    ("design.view", Free),
    // Aprovações e manutenção: só a pessoa, pela tela.
    ("approval.decide", SCREEN_APPROVAL),
    ("approval.list", SCREEN_APPROVAL),
    ("memory.compact", SCREEN_MAINTENANCE),
    ("workspace.restore", SCREEN_MAINTENANCE),
    // A pessoa pela tela ou o orquestrador provado.
    ("fix.decide", CROWN),
    ("peer.answer", CROWN),
    // Abas: a própria, as ligadas no canvas e as que o agente abriu.
    ("tab.output", TAB),
    ("tab.send", TAB),
    ("tab.close", TAB),
    ("tab.state", TAB),
    ("watch.add", TAB),
    ("watch.remove", TAB),
    ("replay.start", TAB),
    ("replay.stop", TAB),
    ("tab.create", CALLER_OR_OUTSIDE),
    // Conversas do modo chat.
    ("chat.show", THREAD),
    ("chat.wait", THREAD),
    ("chat.send", THREAD),
    ("chat.stop", THREAD),
    ("chat.open", THREAD),
    ("chat.settle", THREAD),
    ("chat.goal", THREAD),
    ("chat.compact", THREAD),
    ("chat.pending", Scope(Target::Thread { arg: "thread", optional: true })),
    ("chat.new", CALLER_OR_OUTSIDE),
    // Navegadores do canvas (portais): o handler só enxerga os ligados a quem chama.
    ("portal.list", CALLER),
    ("portal.create", CALLER),
    ("portal.open", CALLER),
    ("portal.close", CALLER),
    ("portal.navigate", CALLER),
    ("portal.history", CALLER),
    ("portal.snapshot", CALLER),
    ("portal.click", CALLER),
    ("portal.hover", CALLER),
    ("portal.type", CALLER),
    ("portal.press", CALLER),
    ("portal.select", CALLER),
    ("portal.scroll", CALLER),
    ("portal.wait", CALLER),
    ("portal.screenshot", CALLER),
    ("portal.console", CALLER),
    ("portal.layout", CALLER),
    ("portal.act", CALLER),
    ("portal.reset", CALLER),
    // Aparelhos do canvas (Android, simulador, iPhone físico): alcance pelo canvas e confirmações por aparelho no handler.
    ("device.list", CALLER),
    ("device.act", CALLER),
    ("device.apps", CALLER),
    ("device.create", CALLER),
    ("device.start", CALLER),
    ("device.tap", CALLER),
    ("device.swipe", CALLER),
    ("device.type", CALLER),
    ("device.key", CALLER),
    ("device.launch", CALLER),
    ("device.close", CALLER),
    ("device.shot", CALLER),
    ("device.tree", CALLER),
    ("device.open", CALLER),
    ("device.button", CALLER),
    ("device.say", CALLER),
    ("device.rotate", CALLER),
    ("device.clipboard", CALLER),
    ("sim.act", CALLER),
    ("desk.act", CALLER),
    // Pares, notas, equipe, chat com a pessoa, rotinas, andares, papéis.
    ("peer.list", CALLER),
    ("peer.ask", CALLER),
    ("peer.tell", CALLER),
    ("peer.deliver", CALLER),
    ("peer.handoff", CALLER),
    ("peer.check", CALLER),
    ("peer.recruit", CALLER),
    ("peer.connect", CALLER),
    ("peer.disconnect", CALLER),
    ("peer.role", CALLER),
    ("peer.queue", CALLER),
    ("peer.receipt", CALLER),
    ("peer.pending", CALLER),
    ("ci.watch", CALLER),
    ("notify.send", CALLER),
    ("note.list", CALLER),
    ("note.read", CALLER),
    ("note.create", CALLER),
    ("note.write", CALLER),
    ("note.edit", CALLER),
    ("team.list", CALLER),
    ("team.candidates", CALLER),
    ("team.create", CALLER),
    ("team.link", CALLER),
    ("team.unlink", CALLER),
    ("team.role", CALLER),
    ("team.delegate", CALLER),
    ("say.send", CALLER),
    ("recall.get", CALLER),
    ("floor.list", CALLER),
    ("floor.create", CALLER),
    ("role.create", CALLER),
    ("role.edit", CALLER),
    ("routine.list", CALLER),
    ("routine.show", CALLER),
    ("routine.create", CALLER),
    ("routine.edit", CALLER),
    ("routine.enable", CALLER),
    ("routine.disable", CALLER),
    ("routine.run", CALLER),
    ("routine.delete", CALLER),
    ("secret.request", CALLER),
    ("secret.consume", CALLER),
    ("secret.revoke", CALLER),
    // Memória e swarm: o handler já prova token + PID da aba (`terminal::authorize`).
    ("memory.search", CALLER),
    ("memory.suggest", CALLER),
    ("memory.history", CALLER),
    ("memory.index", CALLER),
    ("memory.open", CALLER),
    ("memory.usage", CALLER),
    ("memory.export", CALLER),
    ("swarm.note", CALLER),
    ("swarm.question", CALLER),
    ("swarm.promote", CALLER),
    ("swarm.read", CALLER),
    // Designs, skills, janelas, workspaces, pools: o agente provado ou a pessoa fora.
    ("design.create", CALLER_OR_OUTSIDE),
    ("design.delete", CALLER_OR_OUTSIDE),
    ("design.archive", CALLER_OR_OUTSIDE),
    ("design.page.add", CALLER_OR_OUTSIDE),
    ("design.page.rename", CALLER_OR_OUTSIDE),
    ("design.page.delete", CALLER_OR_OUTSIDE),
    ("design.artboard.add", CALLER_OR_OUTSIDE),
    ("design.artboard.update", CALLER_OR_OUTSIDE),
    ("design.artboard.revert", CALLER_OR_OUTSIDE),
    ("design.artboard.approve", CALLER_OR_OUTSIDE),
    ("design.artboard.reject", CALLER_OR_OUTSIDE),
    ("design.artboard.duplicate", CALLER_OR_OUTSIDE),
    ("design.artboard.delete", CALLER_OR_OUTSIDE),
    ("design.artboard.resize", CALLER_OR_OUTSIDE),
    ("design.update", CALLER_OR_OUTSIDE),
    ("design.revert", CALLER_OR_OUTSIDE),
    ("design.approve", CALLER_OR_OUTSIDE),
    ("design.approve.all", CALLER_OR_OUTSIDE),
    ("design.reject", CALLER_OR_OUTSIDE),
    ("design.comment", CALLER_OR_OUTSIDE),
    ("design.comment.add", CALLER_OR_OUTSIDE),
    ("design.comment.resolve", CALLER_OR_OUTSIDE),
    ("design.note.add", CALLER_OR_OUTSIDE),
    ("design.open", CALLER_OR_OUTSIDE),
    ("skill.install", CALLER_OR_OUTSIDE),
    ("skill.new", CALLER_OR_OUTSIDE),
    ("skill.edit", CALLER_OR_OUTSIDE),
    ("window.create", CALLER_OR_OUTSIDE),
    ("workspace.open", CALLER_OR_OUTSIDE),
    ("pool.create", CALLER_OR_OUTSIDE),
    // Frota: o `taskId` (ou a aba) declarado tem de ser o provado.
    ("run.approve", FLEET),
    ("run.roster", FLEET),
    ("run.plan", FLEET),
    ("run.addTask", FLEET),
    ("run.delegateTask", FLEET),
    ("run.status", FLEET),
    ("run.result", FLEET),
    ("run.await", FLEET),
    ("run.handoff", FLEET),
    ("run.addFact", FLEET),
    ("run.facts", FLEET),
    ("run.factBody", FLEET),
    ("run.cancelTask", FLEET),
    ("run.rerouteTask", FLEET),
    ("run.harnessGraph", FLEET),
    ("browser.run", FLEET),
    ("forge.run", FLEET),
    ("gemini.status", FLEET),
    ("gemini.consult", FLEET),
    ("gemini.result", FLEET),
    ("user.ask", FLEET),
    ("memory.list", TASK),
    ("memory.get", TASK),
    ("memory.searchApproved", TASK),
    ("memory.workspaceHistory", TASK),
    ("memory.propose", TASK),
    ("memory.update", TASK),
    ("memory.delete", TASK),
    ("memory.promoteFact", TASK),
    // Missões: a do próprio quadro; aplicar, aceitar, reentregar e limpar só o orquestrador dela. Criar e iniciar (custa
    // orçamento) só fora do app.
    ("mission.status", MISSION),
    ("mission.wait", MISSION),
    ("mission.review", MISSION),
    ("mission.timings", MISSION),
    ("mission.precheck", MISSION),
    ("mission.startcheck", MISSION),
    ("mission.efficiency", MISSION),
    ("mission.accept", MISSION_CROWN),
    ("mission.apply", MISSION_CROWN),
    ("mission.redeliver", MISSION_CROWN),
    ("mission.cleanup", MISSION_CROWN),
    ("mission.create", OUTSIDE),
    ("mission.run", OUTSIDE),
    ("mission.start", OUTSIDE),
    ("worktrees.prune", OUTSIDE),
    ("pool.delete", OUTSIDE),
];

/// A classe de um método, ou `None` se ele não foi classificado (e então é recusado).
pub(crate) fn class_of(command: &str) -> Option<&'static Class> {
    METHODS.iter().find(|(method, _)| *method == command).map(|(_, class)| class)
}

fn unclassified(command: &str) -> String {
    format!(
        "O comando `{command}` não tem classe de autorização no ADE AGS (ipc/authz.rs): recusado. Todo método do IPC precisa de uma classe; \
método sem classificação fecha por padrão."
    )
}

fn task_refusal(command: &str) -> String {
    format!(
        "`{command}` age sobre abas, conversas e o canvas, que uma tarefa da Frota não tem: o comando foi recusado. \
Use as ferramentas de tarefa (`run_*`, `task_*`) ou peça à pessoa."
    )
}

fn not_in_ade(command: &str) -> String {
    format!(
        "Este comando só funciona dentro de um terminal do ADE AGS (falta ADE_TAB_ID): `{command}` age pela aba ou conversa de quem chama, e este \
chamador não prova nenhuma. Rode o `ags` no shell da aba ou da conversa."
    )
}

fn only_person(command: &str) -> String {
    format!(
        "`{command}` apaga disco, gasta orçamento ou muda a configuração da pessoa, e nenhum agente o faz pelo IPC: peça à pessoa \
(pela tela da ADE AGS ou pelo `ags` num terminal dela, fora do app)."
    )
}

fn screen_only(command: &str, why: &str) -> String {
    format!("`{command}`: {why} A pessoa decide pela tela da ADE AGS; um agente só com o papel provado de orquestrador.")
}

/// O que o pedido declara de identidade tem de ser a aba provada.
fn claims_match(args: &Value, me: &str) -> Result<(), String> {
    for key in ["from", "tabId"] {
        if let Some(claimed) = args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
            if claimed != me {
                return Err(format!(
                    "O pedido diz ser `{claimed}` ({key}), mas o processo que chamou é a aba `{me}`. Não defina ADE_TAB_ID nem --from à mão; \
use o ambiente que o app deu ao terminal."
                ));
            }
        }
    }
    Ok(())
}

fn with_key(args: &Value, key: &str, value: &str) -> Value {
    let mut patched = args.clone();
    if let Some(map) = patched.as_object_mut() {
        map.insert(key.into(), Value::String(value.to_string()));
    }
    patched
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn truthy(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(value)) => matches!(value.as_str(), "" | "true" | "1" | "yes"),
        _ => false,
    }
}

const THREAD_PREFIX: &str = crate::chat_team::model::THREAD_PREFIX;

/// A referência de conversa de um recurso: `thread:<id>` (aceita o id já com o prefixo).
fn thread_ref(id: &str) -> String {
    if id.starts_with(THREAD_PREFIX) { id.to_string() } else { format!("{THREAD_PREFIX}{id}") }
}

fn out_of_reach(command: &str, kind: &str, target: &str) -> String {
    format!(
        "A {kind} {target} não é sua nem do seu time: `{command}` só age em si, no que o canvas liga a você e no que você mesmo abriu \
(`ags tab create`, `ags chat new`). Para falar com um agente conectado use `ags peer tell`; para outra aba ou conversa, peça à pessoa que a conecte no canvas."
    )
}

/// Autoriza `command` e devolve os argumentos que o handler deve usar (com a identidade **provada** no lugar da declarada).
///
/// - `who` prova quem chama (só é chamado se a classe precisa);
/// - `boards` carrega o canvas (idem);
/// - `opened_by` diz quem abriu um recurso (aba ou `thread:<id>`).
pub(crate) fn authorize(
    command: &str,
    args: &Value,
    who: impl FnOnce() -> Result<Principal, String>,
    boards: impl FnOnce() -> Boards,
    opened_by: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    let Some(class) = class_of(command) else { return Err(unclassified(command)) };
    match *class {
        Class::Free => Ok(args.clone()),
        Class::Person(message) => Err(message.to_string()),
        Class::PersonOrScope(Role::Crown) => match who()? {
            Principal::Tab(me) => {
                claims_match(args, &me)?;
                if crate::canvas::is_orchestrator(&boards(), &me) {
                    Ok(with_key(args, "from", &me))
                } else {
                    Err(screen_only(command, "Só o orquestrador (a coroa no canvas) decide ou responde por um integrante; um integrante leva a dúvida a ele."))
                }
            }
            Principal::Task(_) => Err(task_refusal(command)),
            Principal::Outside => Err(screen_only(command, "Quem roda fora do app não prova papel nenhum.")),
        },
        Class::Scope(target) => scope(command, args, target, who()?, boards, opened_by),
    }
}

fn scope(
    command: &str,
    args: &Value,
    target: Target,
    principal: Principal,
    boards: impl FnOnce() -> Boards,
    opened_by: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    match (target, principal) {
        // Fora de toda árvore do ADE, sem identidade: a pessoa num terminal próprio (ou CI). O acesso de sempre.
        (Target::Outside, Principal::Outside) => Ok(args.clone()),
        (Target::Outside, _) => Err(only_person(command)),
        (Target::Tab(_) | Target::Thread { .. } | Target::Fleet | Target::Mission { .. } | Target::CallerOrOutside, Principal::Outside) => Ok(args.clone()),
        (Target::Caller | Target::Task, Principal::Outside) => Err(not_in_ade(command)),

        // A tarefa da Frota.
        (Target::Fleet | Target::Task, Principal::Task(task)) => {
            if text(args, "from").is_some() || text(args, "tabId").is_some() {
                return Err(format!("A tarefa `{task}` declarou uma aba em `{command}`: uma tarefa age como tarefa. O comando foi recusado."));
            }
            match text(args, "taskId") {
                Some(declared) if declared != task => Err(format!("O pedido diz ser a tarefa `{declared}`, mas o processo que chamou é o da tarefa `{task}`.")),
                Some(_) => Ok(args.clone()),
                None => Ok(with_key(args, "taskId", &task)),
            }
        }
        (Target::Task, Principal::Tab(_)) => Err(format!("`{command}` é uma ferramenta de tarefa da Frota (MCP `--task`): uma aba usa `ags memory search`, `ags memory index` ou `ags memory open`.")),
        (_, Principal::Task(_)) => Err(task_refusal(command)),

        // Uma aba ou conversa provada.
        (Target::Fleet, Principal::Tab(me)) => {
            claims_match(args, &me)?;
            if text(args, "taskId").is_some() {
                return Err(format!("`{command}` declara uma tarefa da Frota, mas quem chamou é a aba `{me}`: o `taskId` só vale para o processo da tarefa."));
            }
            Ok(args.clone())
        }
        (Target::Tab(arg), Principal::Tab(me)) => {
            claims_match(args, &me)?;
            let Some(tab) = text(args, arg) else { return Err(format!("`{command}` precisa do alvo (--{arg}).")) };
            if crate::ipc::guard::in_reach(&boards(), &me, tab, opened_by(tab).as_deref()) {
                Ok(args.clone())
            } else {
                Err(out_of_reach(command, "aba", tab))
            }
        }
        (Target::Thread { arg, optional }, Principal::Tab(me)) => {
            claims_match(args, &me)?;
            let Some(thread) = text(args, arg) else {
                return if optional {
                    Err(format!("`{command}` sem a conversa lista as de todo mundo: um agente diz qual (--{arg} <id>)."))
                } else {
                    Err(format!("`{command}` precisa da conversa (--{arg})."))
                };
            };
            let key = thread_ref(thread);
            if crate::ipc::guard::in_reach(&boards(), &me, &key, opened_by(&key).as_deref()) {
                Ok(args.clone())
            } else {
                Err(out_of_reach(command, "conversa", thread))
            }
        }
        (Target::Mission { arg, crown }, Principal::Tab(me)) => {
            claims_match(args, &me)?;
            let Some(mission) = text(args, arg) else { return Err(format!("`{command}` precisa da missão (--{arg}).")) };
            let boards = boards();
            if crate::canvas::mission_of_tab(&boards, &me).as_deref() != Some(mission) {
                return Err(format!("A missão {mission} não é a do seu quadro: `{command}` só age na missão a que você pertence."));
            }
            if crown && !crate::canvas::is_orchestrator(&boards, &me) {
                return Err(format!("`{command}` muda o resultado da missão: só o orquestrador dela (a coroa no canvas) o faz, ou a pessoa pela tela."));
            }
            Ok(args.clone())
        }
        (Target::Caller, Principal::Tab(me)) => {
            claims_match(args, &me)?;
            Ok(with_key(args, "from", &me))
        }
        (Target::CallerOrOutside, Principal::Tab(me)) => {
            claims_match(args, &me)?;
            extra_rule(command, args, &me)?;
            Ok(with_key(args, "from", &me))
        }
    }
}

/// Regras que dependem do argumento, e não só do método.
fn extra_rule(command: &str, args: &Value, me: &str) -> Result<(), String> {
    match command {
        // Fechar o workspace atual mata os terminais da pessoa (AGENTS.md §2.1): só ela.
        "workspace.open" if truthy(args, "closeCurrent") => Err(
            "Fechar o workspace atual (`--close-current`) encerra os terminais e agentes da pessoa: só ela faz isso. Abra o workspace sem essa opção.".into(),
        ),
        // Uma conversa filha nasce sob quem a abriu: `parent_ref` de outro agente injetaria a entrega no pai alheio.
        "chat.new" => match text(args, "parent_ref") {
            Some(parent) if parent != me && parent != format!("tab:{me}") => Err(format!(
                "A conversa de origem `{parent}` não é a sua (`{me}`): uma conversa filha só nasce sob quem a abre."
            )),
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}
