//! Como um envio a uma conversa por protocolo pode terminar, sem nada de Tauri: o consumidor da fila
//! (`peer_queue::thread_outbox`) decide o que fazer com a mensagem pela CLASSE do erro, e `api::send`
//! (que fala com o agente) é quem classifica.

/// Como a mensagem entra na conversa.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendMode {
    /// Só com a conversa livre: abre um turno novo. Com turno em andamento, devolve [`SendError::Busy`].
    QueueAfterActive,
    /// Entra no turno em andamento (`turn/steer`); sem turno, abre um. É o "enviar agora".
    SteerActive,
}

impl SendMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SendMode::QueueAfterActive => "queue_after_active",
            SendMode::SteerActive => "steer_active",
        }
    }
}

/// O erro de um envio, pela única pergunta que importa à fila: o agente PODE ter recebido a mensagem?
/// Repetir um envio que talvez tenha chegado duplica uma ordem; por isso, na dúvida, é `Unknown`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendError {
    /// A conversa está no meio de um turno e o modo não deixa entrar nele. Nada foi enviado; não é falha.
    Busy,
    /// Nada chegou ao agente (a sessão não abriu, o processo já tinha fechado, o pedido nem saiu): é
    /// seguro tentar de novo.
    NotSent(String),
    /// O pedido pode ter chegado (resposta perdida, processo que fechou depois de escrever): NÃO repetir.
    Unknown(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Busy => f.write_str("A conversa está no meio de um turno."),
            SendError::NotSent(m) | SendError::Unknown(m) => f.write_str(m),
        }
    }
}

impl From<SendError> for String {
    fn from(e: SendError) -> String {
        e.to_string()
    }
}
