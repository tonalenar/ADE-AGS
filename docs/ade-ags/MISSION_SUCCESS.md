# Sucesso das missões

## Checagem antes de lançar (etapa 10, ponto 1)

O precheck reaproveita o roster e o catálogo por conta antes de lançar. A atribuição do lead e o início em terminais validam instalação, sessão exposta pela app, limite e disponibilidade do modelo na conta escolhida antes de criar run ou marcar início. A nova checagem não lê arquivos de credenciais.

Catálogo com descoberta confirmada rejeita modelo ausente; descoberta desconhecida permanece desconhecida. Sessão e uso são os estados já expostos pelo roster: não garantem que um login não expire após a checagem, nem saldo de provedores sem consulta de limite. Erros possuem ações em pt-BR/en/es. A checagem anterior de código/histórico continua no briefing.

Revisão QA: terminais com conta automática exigem estado de login da conta principal; a ausência de conta padrão não é tratada como provedor sem contas. A UI traduz as chaves de erro do precheck antes de exibir o aviso.
## Failover por erro de acesso (etapa 10, ponto 2)

Tarefas headless podem repetir uma vez dentro do pool/TUI original após erro de autenticação, limite, modelo ou assinatura/saldo, somente com opt-in. A reserva por task, janela de 3 por pool/hora e cooldown de 30 minutos continuam valendo. O catálogo da conta de destino é usado; somente erro de modelo permite escolher outro modelo com acesso confirmado. O aviso pt-BR/en/es mostra conta, motivo e modelo. Terminais interativos não recebem failover. Detalhes em [POOL_FAILOVER.md](./POOL_FAILOVER.md).
