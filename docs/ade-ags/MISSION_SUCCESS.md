# Sucesso das missões

## Failover por erro de acesso (etapa 10, ponto 2)

Tarefas headless podem repetir uma vez dentro do pool/TUI original após erro de autenticação, limite, modelo ou assinatura/saldo, somente com opt-in. A reserva por task, janela de 3 por pool/hora e cooldown de 30 minutos continuam valendo. O catálogo da conta de destino é usado; somente erro de modelo permite escolher outro modelo com acesso confirmado. O aviso pt-BR/en/es mostra conta, motivo e modelo. Terminais interativos não recebem failover. Detalhes em [POOL_FAILOVER.md](./POOL_FAILOVER.md).
