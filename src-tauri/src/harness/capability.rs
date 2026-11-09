//! Tipos do descritor de capabilities: estado, escopo, prova e a célula por capability.
//!
//! O estado descreve o **adapter do ADE**, não o provider: `Unsupported` quer dizer que o ADE não tem
//! caminho para a capability (ou a recusa de forma explícita). Não prova que o provider não a tenha.

use serde::Serialize;

/// As 18 capabilities que o plano da Fase 0 pede por provider e superfície.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Iniciar uma execução (processo ou sessão).
    Start,
    /// Mandar uma mensagem a uma execução que já existe.
    Send,
    /// Injetar a mensagem no turno em curso, sem parar e sem deixá-la para depois (efeito provado).
    Steer,
    /// Pedir a parada do turno ou da execução em curso.
    Interrupt,
    /// Receber um sinal de fim de turno (protocolo ou código de saída). Silêncio de tela não conta.
    TurnCompletion,
    /// Eventos de início e fim de ferramenta, normalizados.
    ToolEvents,
    /// O agente pergunta à pessoa e o ADE devolve a resposta ao agente.
    Question,
    /// Pedido de permissão que a pessoa ou a política decide e o ADE devolve ao provider.
    Approval,
    /// O harness vê nascer um filho NATIVO do provider (id próprio e pai). Filho criado pelo ADE
    /// (chat filho, tarefa da Frota) não entra aqui: ver `ProviderMatrix::ags_mcp`.
    ChildSpawn,
    /// O resultado do filho nativo chega ao ADE e pode ser gravado.
    ChildResult,
    /// Parar um filho nativo sem parar o pai.
    ChildStop,
    /// Retomar a sessão nativa depois de reiniciar o app.
    Resume,
    /// Compactar o contexto por pedido do ADE, com resposta do protocolo.
    Compact,
    /// Objetivo persistente nativo.
    Goal,
    /// Foto do estado da execução (hoje só de arquivos, nunca da conversa do provider).
    Checkpoint,
    /// Voltar ao estado de uma foto (hoje só arquivos).
    Rollback,
    /// Uso de tokens, custo ou limite por sessão.
    Usage,
    /// Existe fonte contínua de eventos que o ADE lê (stdout, protocolo, transcript ou tela).
    EventSource,
}

impl Capability {
    /// Todas, na ordem em que cada coluna da matriz as lista.
    pub const ALL: [Capability; 18] = [
        Capability::Start,
        Capability::Send,
        Capability::Steer,
        Capability::Interrupt,
        Capability::TurnCompletion,
        Capability::ToolEvents,
        Capability::Question,
        Capability::Approval,
        Capability::ChildSpawn,
        Capability::ChildResult,
        Capability::ChildStop,
        Capability::Resume,
        Capability::Compact,
        Capability::Goal,
        Capability::Checkpoint,
        Capability::Rollback,
        Capability::Usage,
        Capability::EventSource,
    ];

    /// O nome estável, como aparece no doc e na serialização.
    pub const fn id(self) -> &'static str {
        match self {
            Capability::Start => "start",
            Capability::Send => "send",
            Capability::Steer => "steer",
            Capability::Interrupt => "interrupt",
            Capability::TurnCompletion => "turn_completion",
            Capability::ToolEvents => "tool_events",
            Capability::Question => "question",
            Capability::Approval => "approval",
            Capability::ChildSpawn => "child_spawn",
            Capability::ChildResult => "child_result",
            Capability::ChildStop => "child_stop",
            Capability::Resume => "resume",
            Capability::Compact => "compact",
            Capability::Goal => "goal",
            Capability::Checkpoint => "checkpoint",
            Capability::Rollback => "rollback",
            Capability::Usage => "usage",
            Capability::EventSource => "event_source",
        }
    }
}

/// O que o ADE pode prometer sobre a capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    /// Há caminho de código ponta a ponta. A força da prova está em [`Proof`].
    Supported,
    /// Não há caminho no ADE, ou o ADE recusa de forma explícita. A UI e o MCP não devem oferecer.
    Unsupported,
    /// O caminho existe, mas o efeito não tem resposta nem evento observável, ou depende de algo que o
    /// repositório não prova. Não se promete; `Claim::missing` diz o que falta provar.
    Unknown,
}

/// Onde o estado é decidido. A tabela estática traz o valor por instância; o valor por sessão ou por
/// modelo é resolvido em tempo de execução (Fase 3) e pode diferir do padrão.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Vale para o adapter ou o binário inteiro (todas as sessões).
    Instance,
    /// Depende da sessão nativa, da conversa ou da tarefa.
    Session,
    /// Depende do modelo ou da janela de contexto.
    Model,
}

/// A prova mais forte que existe hoje para o estado. Não há captura real de nenhum provider no repositório.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Proof {
    /// Nenhuma: o estado vem da ausência de caminho no código.
    None,
    /// Só leitura de código.
    Code,
    /// Um teste exercita o mapeador ou a decisão, não o provider.
    Test,
    /// Uma fixture sintética de protocolo (`origin.kind: synthesized`).
    Fixture,
    /// Uma captura gravada de um provider real. Nenhuma célula chega aqui ainda.
    RealCapture,
}

/// As três superfícies de execução que o ADE tem.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    /// Conversa estruturada por protocolo (`conversa/`).
    Chat,
    /// Frota headless (`runs/`).
    Fleet,
    /// CLI em terminal real (PTY).
    Tui,
}

impl Surface {
    pub const fn id(self) -> &'static str {
        match self {
            Surface::Chat => "chat",
            Surface::Fleet => "fleet",
            Surface::Tui => "tui",
        }
    }
}

/// O que o descritor afirma sobre uma capability, com a evidência.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Claim {
    pub support: Support,
    pub scope: Scope,
    pub proof: Proof,
    /// Citações `caminho:linha` (ou `caminho:inicio-fim`) relativas à raiz do repositório. Pode ser só
    /// `caminho` quando a prova é o arquivo todo (fixture, doc).
    pub evidence: &'static [&'static str],
    /// Só em `Unknown`: o que falta provar para virar `Supported` ou `Unsupported`.
    pub missing: &'static str,
    /// Observação curta do que o código faz hoje. Em `Unsupported`, o motivo.
    pub note: &'static str,
}

impl Claim {
    /// Só `Supported` pode ser prometido à UI ou ao MCP.
    pub const fn promises(&self) -> bool {
        matches!(self.support, Support::Supported)
    }

    pub const fn supported(scope: Scope, proof: Proof, evidence: &'static [&'static str], note: &'static str) -> Claim {
        Claim { support: Support::Supported, scope, proof, evidence, missing: "", note }
    }

    pub const fn unsupported(scope: Scope, proof: Proof, evidence: &'static [&'static str], note: &'static str) -> Claim {
        Claim { support: Support::Unsupported, scope, proof, evidence, missing: "", note }
    }

    pub const fn unknown(
        scope: Scope,
        proof: Proof,
        evidence: &'static [&'static str],
        missing: &'static str,
        note: &'static str,
    ) -> Claim {
        Claim { support: Support::Unknown, scope, proof, evidence, missing, note }
    }
}

/// Uma capability de um provider numa superfície.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Cell {
    pub capability: Capability,
    pub claim: Claim,
}

/// Uma coluna da matriz: um provider numa superfície, com as 18 capabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ProviderMatrix {
    pub surface: Surface,
    /// O id do registro de agentes (`claude-code`, `codex`…) ou `local-acp` para o ACP cadastrado pela pessoa.
    pub provider: &'static str,
    /// Sempre as 18, na ordem de [`Capability::ALL`].
    pub cells: [Cell; 18],
    /// Fora das 18: o agente consegue chamar as ferramentas `ags` (MCP do ADE) e, assim, criar filhos que o
    /// ADE controla (chat filho, tarefa da Frota)? Decide a delegação, não o filho nativo.
    pub ags_mcp: Claim,
}

/// Contagem por estado, para o doc e para os testes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub supported: usize,
    pub unknown: usize,
    pub unsupported: usize,
}

impl ProviderMatrix {
    /// A célula da capability. A posição é o discriminante do enum; os testes garantem que cada coluna
    /// lista as 18 na ordem de [`Capability::ALL`].
    pub fn cell(&self, capability: Capability) -> &Cell {
        &self.cells[capability as usize]
    }

    pub fn claim(&self, capability: Capability) -> &Claim {
        &self.cell(capability).claim
    }

    pub fn counts(&self) -> Counts {
        let mut counts = Counts::default();
        for cell in &self.cells {
            match cell.claim.support {
                Support::Supported => counts.supported += 1,
                Support::Unknown => counts.unknown += 1,
                Support::Unsupported => counts.unsupported += 1,
            }
        }
        counts
    }
}
