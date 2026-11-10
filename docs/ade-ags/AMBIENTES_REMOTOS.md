# Ambientes remotos e serviço em segundo plano

> Estado: proposta de arquitetura. Nenhum listener remoto ou serviço persistente está habilitado por este documento.

## Objetivo

Permitir que a ADE mantenha projetos e agentes num host e aceite clientes desktop, web e mobile com segurança, mesmo quando a janela principal não está aberta. O código, os processos dos agentes, os arquivos e as credenciais continuam no host escolhido. Um cliente remoto envia comandos autorizados e recebe apenas os eventos necessários para a sessão.

## Evidência da arquitetura atual

- O servidor IPC da ADE escuta em loopback e usa um token da instância. Os transportes locais também usam a identidade do processo quando disponível. O handshake identifica uma instância local; não é pareamento remoto.
- A requisição atual é `{token, command, args}` e segue para um dispatch comum. Esse token autentica o cliente local, mas não representa um principal remoto nem uma permissão específica para cada método.
- O roteador de comandos não possui principal remoto nem autorização por método. O cliente local pode solicitar operações de host abrangentes.
- `--headless` ainda inicializa o processo Tauri e pula serviços de interface; não é um daemon independente.
- O encerramento da aplicação encerra os PTYs. O registro de sessões ativas é mantido em memória, então snapshots do SQLite não permitem recuperar um PTY depois que seu processo morre.

Consequência: não expor o listener atual, o token de `~/.ags/ipc.json`, o MCP local ou `--headless` à rede como primeira versão de acesso remoto.

## Princípios

1. **Um host por conjunto de estado:** só um processo proprietário abre o banco, cria PTYs, lê credenciais do chaveiro e acessa os projetos de um host.
2. **Autenticação não é autorização:** cada pedido remoto tem um principal de dispositivo e uma capacidade explícita. Método sem classificação fica negado.
3. **Menor privilégio por recurso e ação:** distinguir leitura de tela/status, leitura de arquivos, escrita, execução de terminal, aprovação de ações e administração do host. `full` só é concessão explícita, nunca resultado implícito de pareamento.
4. **Segredos ficam no host:** tokens de provedor e credenciais do sistema nunca são enviados aos clientes, URLs, argumentos de processo ou logs.
5. **A rota não muda a identidade:** LAN, VPN, SSH e relay são caminhos de transporte. Uma troca de rota não cria permissões novas nem reativa um dispositivo revogado.
6. **Desconectar é reversível e visível:** fechar um cliente não apaga projetos nem encerra o host. Parar o serviço é uma ação separada e informa se há processos ativos.
7. **Compatibilidade explícita:** contrato RPC versionado separadamente do app, com negociação de capacidades. Cliente ou host incompatível falha com mensagem clara, sem rebaixar silenciosamente a segurança.

## Topologia proposta

```text
ADE Desktop ─────┐
Cliente Web ─────┼── RPC autenticado e versionado ── ADE Host ── projetos, SQLite, PTYs,
Cliente Mobile ──┘                                  processos, devices e chaveiro locais
```

O **ADE Host** é um processo de serviço independente da janela. Ele é o único dono do banco, das sessões de agente e dos recursos locais. A janela desktop e os futuros clientes são clientes do mesmo host. A primeira versão do serviço deve aceitar apenas conexões locais; ela separa o ciclo de vida do host sem abrir uma porta de rede.

Se um dia for necessário suportar múltiplos hosts no mesmo computador, cada um precisa de diretório de dados, endpoint local e bloqueio de propriedade independentes. Dois processos nunca podem disputar o mesmo `data.db` ou a mesma sessão de PTY.

## Contratos de RPC e capacidades

Antes de implementar o host, classificar todos os comandos atuais por recurso, efeito e aprovação. O contrato remoto deve registrar ao menos:

| Campo | Função |
|---|---|
| `request_id` | Deduplicar repetição de um pedido após reconexão, sobretudo em ações mutáveis. |
| `contract_version` | Negociar o formato sem depender da versão da interface. |
| `principal_id` | Identificar a instalação/dispositivo pareado, nunca um nome fornecido pelo cliente. |
| `resource` e `action` | Indicar a conversa, projeto ou dispositivo e a operação solicitada. |
| `required_capabilities` | Permitir que o host aplique política no despacho, e não só esconda botões na UI. |
| `approval` | Registrar pedidos que exigem confirmação interativa no host. Falta de aprovador resulta em negação. |

Capacidades iniciais: `session.observe`, `session.message`, `files.read`, `files.write`, `terminal.execute`, `approval.decide`, `device.observe`, `device.control` e `host.admin`. O registro real de métodos deve ser revisado antes de atribuir capacidades; nenhuma permissão abrangente pode ser inferida apenas por estar autenticado.

Toda chamada usa uma política *deny-by-default*. Eventos também são filtrados por host, projeto, conversa e capacidade. Caminhos de arquivo são resolvidos pelo host dentro das raízes autorizadas; o cliente não escolhe um caminho arbitrário do sistema.

### Inventário inicial do dispatch

Este agrupamento é guia para a auditoria, não uma política automática por prefixo. A implementação deve classificar cada string de comando individualmente: dentro da mesma família, leitura, mutação e execução podem exigir permissões diferentes.

| Família | Exemplos e efeitos | Regras que o contrato remoto precisa separar |
|---|---|---|
| Abas e PTYs | `tab.output`/`tab.state` leem; `tab.send` envia entrada; `tab.create`/`tab.close` alteram sessão. | Saída é conteúdo privado; enviar texto pode executar ações. Criar/fechar dependem da ponte da UI e não podem fingir sucesso sem ela. |
| Conversas | `chat.list`/`chat.show`/`chat.wait` leem; `chat.new`/`chat.send` iniciam ou instruem agentes; `chat.stop` interrompe. | Leitura de transcript merece capacidade própria; escrita e interrupção precisam de escopos por conversa. Nova conversa deve conservar a política de acesso supervisionado existente. |
| Peers, times, runs e missões | `peer.*`, `team.*`, `run.*`, `mission.*`, `approval.*` consultam ou comandam tarefas e agentes. | Podem iniciar execução, gastar orçamento, alterar worktrees e aprovar ações. `run.approve` e `approval.decide` exigem capacidade de aprovação específica. |
| Browser e dispositivos | `portal.snapshot`/`portal.screenshot`, `portal.click`/`portal.type`, `device.shot`/`device.tree`, `device.tap`/`device.type`, `sim.act` e `desk.act`. | Captura pode expor contas logadas; clique, texto, clipboard e gesto são controle ativo. Separar observar, interagir e transferir clipboard. |
| Arquivos, skills, Git e Design | `workspace.*`, `skill.*`, `worktrees.*`, `forge.run`, `design.*`. | Separar leitura, escrita, instalação e chamadas externas; limitar caminhos às raízes autorizadas e tratar APIs do forge como efeitos externos. Algumas ações dependem da ponte da UI. |
| Memória e automações | `memory.*`, `note.*`, `routine.*`, `scheduled_task`, `swarm.*`. | Consultas podem expor conteúdo; escrita altera memória persistente. Ações agendadas precisam ser autorizadas de novo quando executarem. |
| Segredos, aprovações e mensagens | `secret.*`, `approval.*`, `user.ask`, `notify.send`, `say.send`, `mcp.cancel`. | Manter os escopos por host/conversa; não devolver segredo ao cliente; sem aprovador local, negar. |
| Host e eventos | `app.status`, `agent.list`, `events.*`, `watch.*`, `pool.list`, `replay.*`. | Mesmo leitura pode expor nomes e atividade. `replay.start` grava saída da sessão e não pertence ao escopo read-only. |

O catálogo completo deve ser gerado ou conferido contra o match exato em `src-tauri/src/ipc/commands/dispatch.rs`. Não autorizar comandos novos automaticamente por terem um prefixo conhecido.

## Pareamento e revogação

1. O usuário inicia o pareamento no host e vê uma solicitação com dispositivo, host e capacidades pedidas.
2. O convite usa um código curto/QR de uso único, prazo curto e proteção contra tentativas. Ele não contém um token permanente.
3. Após aprovação local, os pares trocam chaves públicas e estabelecem uma identidade por dispositivo. A chave privada fica no armazenamento seguro do cliente; o host guarda a chave pública, capacidades concedidas, data e estado de revogação.
4. O transporte exige TLS com identidade de peer ou protocolo equivalente revisado. Uma camada de sessão não pode aceitar origem web arbitrária; deve proteger contra CSRF, replay, downgrade e abuso de reconexão.
5. Revogar invalida tokens/sessões ativos imediatamente e grava um evento de auditoria sem conteúdo sensível.
6. Um cliente removido precisa de novo pareamento aprovado pelo usuário. Trocar LAN por VPN não contorna a revogação.

Tokens e códigos não aparecem em query strings, clipboard automático, stdout, telemetria ou logs. Convites expiram e não são reutilizáveis.

## Rotas e reconexão

Cada host pode anunciar rotas elegíveis (loopback, LAN, VPN/Tailscale, SSH/túnel e, futuramente, relay). A identidade do host é estável entre rotas. A rota ativa informa seu tipo e propriedades, mas a permissão efetiva é a interseção das capacidades concedidas ao dispositivo com a política do host/rota.

O cliente pode priorizar a rota de menor latência e trocar para outra quando a atual falhar. A troca deve preservar `principal_id`, contrato e cursor de eventos, deduplicar comandos por `request_id` e não repetir automaticamente ações não idempotentes sem confirmação. O retorno a uma rota melhor não reinicia a conversa nem reenvia comandos. LAN/VPN e internet via relay são fases separadas; descoberta local não publica a ADE na internet.

## Serviço e dados ativos

- Fechar a janela desktop deixa o host ativo quando o usuário habilitou serviço em segundo plano.
- A ação **Parar host** é separada de fechar a janela e mostra sessões ativas. A política de encerramento deve ser definida pelo usuário; não matar agentes silenciosamente.
- Reiniciar ou atualizar o host pode encerrar PTYs. Antes de fazê-lo, mostrar as sessões afetadas e permitir esperar, cancelar ou confirmar encerramento.
- Inicialização única usa lock e registra PID/versão. Falha ou processo obsoleto permite recuperação sem apagar banco nem matar processos por nome genérico.
- Instaladores, atualizações e inicialização do serviço são específicos por plataforma. A interface informa quando o host está inacessível ou numa versão incompatível.
- Estado de conexão, permissões e ações ficam auditáveis localmente, sem transcript nem conteúdo de segredo por padrão.

## Fases de implementação e critérios de saída

| Fase | Entrega | Critério para avançar |
|---|---|---|
| 0. Inventário e contrato | Catálogo exato por comando (não por prefixo), capacidade/efeito, dependência da ponte UI, RPC versionado e políticas deny-by-default em transporte falso/in-process. | Cada comando tem classe de risco, regra e comportamento sem UI/aprovador; métodos desconhecidos são negados; operação local atual permanece compatível. |
| 1. Host local | Processo host independente e ciclo de vida local `status/start/stop`; nenhum listener de rede. | Uma janela pode fechar/reabrir sem perder sessões; só um host possui o banco e os PTYs. |
| 2. Cliente desktop | ADE desktop conecta ao serviço local pelo transporte autenticado do SO; host concentra persistência e agentes. | Recuperação após reinício da UI, versão incompatível e host parado são compreensíveis; nenhum PTY é remontado/perdido por atualização da interface. |
| 3. Identidade | Pareamento local aprovado, identidade por dispositivo, capacidades, revogação e auditoria. | Revogação impede pedidos já conectados e após reconexão; chaves ficam no chaveiro e não vazam em URL/log. |
| 4. Rede privada | Uma rota LAN/VPN por vez, depois seleção e failover entre rotas autenticadas. | TLS/identidade de peer, CSRF/origem, replay, retomada e comandos não idempotentes passam revisão de segurança. Escopos não sobem ao trocar de rota. |
| 5. Clientes thin | Web/mobile com telas, timeline e ações permitidas pelo contrato. Browser e device continuam recursos do host, com status de stream explícito. | Cliente não recebe chave de provider; eventos são limitados ao que seu principal pode ver; perda de conexão não duplica ações. |
| 6. Túnel/relay | Acesso fora da rede privada, opt-in e independente da conexão LAN. | Revisão de ameaça, limites, rate limiting, rotação/revogação e operação/atualização do relay definidos antes da publicação. |

Configurações por ambiente conectado são um trabalho relacionado, mas separado: preservar os padrões atuais de máquina/projeto e introduzir `host_id`/`environment_id` estáveis e origem por campo antes de mudar a precedência. Nomes de projeto ou caminhos não servem como identidade sincronizável. Uma proposta inicial é máquina → host/ambiente → projeto → conversa, com estados explícitos herdado/fixado/misto; essa precedência ainda precisa ser validada contra a UX e o formato de migração.

## Relação com T3 Code

Esta arquitetura se inspira nos conceitos documentados pelo T3: serviço em segundo plano, pareamento de clientes, rotas LAN/VPN/SSH, permissões por rota e cliente, e host como dono de arquivos, credenciais e processos. A ADE manterá seus próprios contratos, agentes e políticas locais.

- [Acesso remoto no T3 Code](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
- [Serviço em segundo plano no T3 Code](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md)
- [Visão interna do T3 Code](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)

