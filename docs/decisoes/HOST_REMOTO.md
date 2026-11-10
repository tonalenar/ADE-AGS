# Host remoto e serviço em segundo plano: modelo de ameaça e pré-requisitos

> Fase 8 da auditoria de paridade. Documento de **decisão e revisão de superfície**. Nada foi aberto à rede: bind em `127.0.0.1`, porta efêmera e transporte não mudaram. A análise original só acrescentou seis testes de guarda; as correções de F-01 e de F-02, F-03, F-05, F-07, F-08 e F-09 (parcial), com `peer.answer` e `fix.decide`, vieram depois, com OK explícito, e estão em §6.

- Data: 2026-11-10. Base: commit `62846e26` (início da análise).
- Relacionados: [AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md) (proposta), [SEGURANCA_LOCAL.md](../ade-ags/SEGURANCA_LOCAL.md), [COMPUTER_USE_SUPERFICIES.md](../ade-ags/COMPUTER_USE_SUPERFICIES.md), [ESPELHAMENTO_IPHONE.md](../ade-ags/ESPELHAMENTO_IPHONE.md), [CLI_MCP.md](../agentes/CLI_MCP.md).

Salvo indicação, `arquivo:linha` é relativo a `src-tauri/src/`.

## 1. Resumo

- O IPC de hoje é um listener TCP em `127.0.0.1` com um token por processo, mais um canal de credencial com PID (§3). Ele não está exposto à rede **por causa do bind e do token**, não por um modelo de autorização.
- Um token dá acesso a **217 dos 221 métodos** do inventário; os 2 de manutenção e, desde a correção de F-01, `approval.decide` e `approval.list` são negados a todos (antes do `match`). Os métodos que dependem de PID exigem também o canal de credencial. O token é legível por qualquer processo do mesmo usuário, inclusive por agentes que rodam comandos. Ele não separa processos do mesmo usuário nem identifica cliente.
- **Decisão:** o listener atual não será exposto à rede, nem com TLS na frente. O host remoto precisa de um contrato novo (identidade de cliente, capacidades por método, versão, limites antes da autenticação). Não é um túnel para este listener.
- Achados (§6): **1 alta**, **3 médias** confirmadas, **1 média** condicional (não verificada), **5 baixas**, **2 informativos**. **Estado:** corrigidos F-01, F-02, F-03, F-05, F-07 e F-08; **F-09 parcial** (só `tab.send`); F-04 e F-10 seguem não verificados; F-06, F-11 e F-12 sem mudança. `peer.answer` e `fix.decide` agora exigem papel provado.
- Guardas (§9): **seis testes** em `ipc/test.rs`, que passam no código atual. Nenhuma falha de produção apareceu que exigisse parar.
- Não verificado (§10): prova em runtime (nenhum processo do app estava rodando e a aplicação não foi executada nesta tarefa), Windows, medições de sandbox e de carga.

## 2. Método e escopo

- Lido: `ipc/{server,transport,protocol,mod}.rs`, `ipc/commands/{dispatch,tabs,missions,runs,agent_secrets}.rs`, `bin/cli.rs`, `ipc/mcp.rs` (anotações `DESTRUCTIVE`), `ipc/bridge.rs`, `terminal/session.rs`, `runs/{mod,broker,orchestration,policy,agents}.rs`, `memory.rs`, `approval_audit.rs`, `app/{run,shutdown,housekeeping}.rs`, `terminal/pty_manager.rs`, `database/wal.rs`, `preview/proxy.rs`, `accounts/antigravity_oauth.rs`, `util/loopback_trust.rs`, `util/datadir.rs`, `build.rs`, `capabilities/default.json`, `real_browser/native.rs`.
- Documentos: AGENTS.md, `docs/agentes/{BACKEND,CLI_MCP}.md`, `docs/ade-ags/{ARCHITECTURE,AMBIENTES_REMOTOS,SEGURANCA_LOCAL,COMPUTER_USE_SUPERFICIES}.md`, e o início de `ESPELHAMENTO_IPHONE.md`.
- Não executei a aplicação nem um build de instalação. Rodei `cargo test --lib ipc` e `cargo test --lib --bin ags` (§9).
- A classificação dos métodos (Anexo A) é **preliminar**: vem do nome e da leitura de alguns handlers. A auditoria por handler é o item 0 do plano.

## 3. Inventário da superfície atual (a)

### 3.1 Transporte e bind

| Item | Estado atual | Onde |
|---|---|---|
| Listener TCP | `127.0.0.1`, porta efêmera escolhida pelo SO. É o único `TcpListener::bind` do IPC | server.rs:63-65 |
| Formato | uma linha JSON por pedido e uma por resposta. Não é HTTP | server.rs:255-292; protocol.rs:137-164 |
| Canal de credencial (Unix) | socket `~/.ags/ipc/<pid>.sock`, `0600`. Entrega o PID de quem chama | protocol.rs:43-47; transport.rs:226-266 |
| Canal de credencial (Windows) | named pipe `\\.\pipe\ags-ipc-<pid>`, com `PIPE_REJECT_REMOTE_CLIENTS` | protocol.rs:48-50; transport.rs:269-295 |
| Limite de conexões | 256, **um orçamento só** para TCP e credencial | server.rs:23, 70, 95; transport.rs:247, 328 |
| Limite de pedido | 8 MiB, lidos **antes** da checagem do token | server.rs:27, 255, 269 |
| Prazo de leitura | 30 s **por leitura** | server.rs:106; transport.rs:257 |
| Cliente da CLI | conecta a `127.0.0.1` na porta do handshake. O endereço é fixo | transport.rs:133-145 |

Outros listeners do app, todos em loopback: o proxy de preview (`127.0.0.1` e `::1`, preview/proxy.rs:1291-1296, com `loopback_trust` em :208-213) e o callback OAuth do Antigravity (porta efêmera; `state` conferido em accounts/antigravity_oauth.rs:173; bind em :351). A busca por `TcpListener` e `UnixListener` em código de produção não achou listener fora do loopback. Os `TcpListener` de `decisions/` estão em `mod tests`.

### 3.2 Autenticação, identidade e arquivos

| Item | Estado atual | Onde |
|---|---|---|
| Token | UUID v4, um por início do processo | server.rs:66 |
| Comparação | tempo constante. Token ausente ou errado recebe `Token inválido`, antes de qualquer comando | server.rs:31-37, 267-270 |
| Identidade de quem chama | PID só no canal de credencial. No TCP é `None` | server.rs:112; transport.rs:252, 262 |
| Onde ficam porta e token | `~/.ags/ipc.json` (global) e `~/.ags/ipc/<pid>.json`. Campos `port`, `token`, `pid`, `protocol`, `socket` | protocol.rs:20-22, 35-37, 118-133; server.rs:78-88 |
| Raiz de dados | `~/.ags`, ou `ADE_AGS_DATA_DIR` se for caminho absoluto | util/datadir.rs:14-22 |
| Permissão dos arquivos | `0600`, aplicada depois da escrita (ver F-05) | server.rs:126-145; transport.rs:236 |
| Permissão das pastas | `~/.ags` e `~/.ags/ipc` criadas sem modo explícito. Os únicos `0o700` de produção são de anexos e do spill | server.rs:127-129; transport.rs:231-233; terminal/attachments.rs:50; ipc/spill.rs:67 |
| Como a CLI acha o handshake | variável `AGS_HANDSHAKE` herdada (ou `CONTROLCODE_HANDSHAKE`). Sem ela, o arquivo global e fallbacks por `HOME`/`USERPROFILE` | server.rs:44-48; protocol.rs:61-93 |
| Versão do protocolo | `PROTOCOL_VERSION = 1`, com comparação de igualdade na CLI | protocol.rs:135; cli.rs:1587-1592 |
| Vida do token | a do processo. Sem expiração e sem revogação | server.rs:66, 234-242 |
| Quem lê o token | qualquer processo do mesmo usuário com acesso ao arquivo: a CLI, o `ags mcp` e os agentes, que chamam a CLI | cli.rs:1599; CLI_MCP.md:58 |

### 3.3 Métodos expostos

- **221 braços** no `match` do despachador (dispatch.rs:99-348), todos com ponto no nome. *Depois de F-01 o `match` tem 219: `approval.decide` e `approval.list` saíram e são recusados antes dele. O Anexo A abaixo é o inventário original.*
- Antes do `match`: a negação de manutenção, para **qualquer** chamador (dispatch.rs:86; ipc/mod.rs:31-35). E a checagem de papel Dreamer quando há `taskId` (dispatch.rs:89-98; runs/policy.rs:107-119).
- O despachador **não confere identidade**. Só alguns métodos conferem, por conta própria e por PID de ancestralidade (terminal/session.rs:172-211): memória e swarm de sessão, segredos (ipc/commands/agent_secrets.rs:13-21) e computer use (computer_use/ios.rs:594).
- Classificação preliminar (Anexo A):

| Classe | Significado | Quantidade |
|---|---|---|
| L | leitura (pode expor conteúdo) | 82 |
| E | escrita comum (estado do app ou dados) | 64 |
| X | executa ou controla (processo, terminal, agente, navegador, aparelho, chamada externa) | 53 |
| D | destrutivo (apaga, fecha, cancela, para ou descarta) | 15 |
| A | decisão ou fluxo de aprovação | 3 |
| S | segredo | 2 |
| M | manutenção, negada a todo chamador do IPC | 2 |

- **Destrutivos (D):** `chat.stop`, `design.archive`, `design.artboard.delete`, `design.delete`, `design.page.delete`, `mcp.cancel`, `mission.cleanup`, `pool.delete`, `portal.close`, `portal.reset`, `routine.delete`, `run.cancelTask`, `secret.revoke`, `tab.close`, `worktrees.prune`. Mais `memory.compact` e `workspace.restore` (M), que só a interface executa.
- Na ferramenta MCP, a anotação `destructiveHint` cobre `browser_eval`, `task_cancel`, `device_action`, `secret_request`, `secret_run` e `secret_revoke` (mcp.rs:1569, 1590-1606).

### 3.4 Superfícies correlatas

- **CLI `ags`.** Mesmo protocolo. As recusas do lado da CLI (manutenção, cli.rs:570; `secret.consume`, cli.rs:1007) são conveniência. A barreira é o servidor, como diz o próprio código (cli.rs:568-569).
- **MCP `ags mcp`.** Ponte stdio que transforma cada `tools/call` em um `Request` do mesmo protocolo (CLI_MCP.md:58).
- **Ponte com a interface.** `bridge.rs` espera a janela por 15 s (bridge.rs:24) e responde com mensagem de janela oculta (bridge.rs:88-107). Por grep, há 7 chamadas `bridge_call(` em `ipc/commands` (14 arquivos de `ipc/commands` citam `bridge_call` ou `ask_frontend`) e 24 chamadas a `ask_frontend`/`ask_frontend_within` em `src-tauri/src`, sem separar testes.
- **Comandos Tauri da interface.** São outro caminho, não o IPC. A capability vale para `"*"` (capabilities/default.json:5-7), e `build.rs:3` chama `tauri_build::build()` sem `AppManifest`. Ver §10.

## 4. Modelo de ameaça (b)

### 4.1 Ativos

Token e handshake (acesso a tudo que o IPC faz). PTYs e o texto enviado a eles. Aprovações e regras persistentes (`permission_rules`). Memória compartilhada e a identidade de quem propõe. Segredos temporários (o valor sai por `secret.consume`, só pelo canal com PID). Repositórios e worktrees. Dispositivos e capturas de tela. `~/.ags/data.db`, que este trabalho não toca.

### 4.2 Atores (estado atual)

| Ator | Caminho até o IPC | O que barra hoje | Achados | Avaliação |
|---|---|---|---|---|
| Outro usuário da máquina | TCP em `127.0.0.1` (o loopback não separa usuários). Socket só do dono | sem o token, o pedido para em server.rs:269. O arquivo do token é `0600` | F-03, F-05 | Negação de serviço e consumo de memória sem token. Vazamento do token só numa corrida com o arquivo |
| Processo do mesmo usuário (app, malware) | lê `~/.ags/ipc.json` | nada no ADE. Só o SO | F-09, F-11 | Equivale ao usuário. O ADE não separa processos do mesmo usuário |
| Agente de IA do mesmo usuário | Bash, `ags`, MCP. Lê o arquivo se a política do próprio agente deixar | token. PID só em parte dos métodos. Manutenção negada | F-01, F-02, F-04, F-09 | **Maior risco prático**: um principal do mesmo usuário guiado por entrada não confiável (páginas, memória, mensagens de peers) |
| Página web (DNS rebinding, `fetch`, formulário) | HTTP para `127.0.0.1:<porta>` | a primeira linha HTTP não é JSON e é recusada. Sem o token, nada passa de server.rs:269 | F-06 | Sem caminho hoje. Defesa por formato, frágil |
| Extensão de navegador | mesma rede de uma página. Sem leitura de arquivo | igual à página. Não há `nativeMessaging` no repositório (busca por texto) | F-06 | Sem caminho hoje |
| Rede local ou internet | nenhum listener fora do loopback | bind em `127.0.0.1` (server.rs:63), coberto pelas guardas de §9 | — | Fechado hoje |
| Páginas dentro do app | painel de navegador: view nativa, não webview Tauri (real_browser/native.rs:3) | separação de view | — | Não verificado em detalhe (§10) |

### 4.3 STRIDE

- **Spoofing:** tarefa e aba são afirmadas no payload (F-02). O PID cobre só parte dos métodos (F-12).
- **Tampering:** `tab.send` escreve em qualquer PTY por id, sem checar quem chama (F-09). O handshake pode ser redirecionado pelo ambiente (F-07).
- **Repudiation:** o IPC não registra quem chama. Só conta bytes (server.rs:287-289). Aprovações não guardam a origem da decisão no pedido; com F-01 só a interface decide (`DecidedBy::User`).
- **Information disclosure:** `approval.list` expunha o `input` bruto da ferramenta (F-01, fechado). `tab.output` lê o terminal. `secret.consume` devolve o valor, só com PID (F-12).
- **Denial of service:** slots e memória antes do token (F-03).
- **Elevation of privilege:** aprovar e lembrar regra (F-01). Agir como outra tarefa (F-02). Enviar texto a outra aba (F-09).

### 4.4 Alvo remoto

Cada linha de §4.3 vira requisito do host remoto: identidade de dispositivo (S), TLS com identidade de peer (T), log por principal sem conteúdo (R), filtro de eventos por capacidade (I), teto e prazo antes da autenticação (D), capacidade por método e por workspace (E). A revogação entra em §5.

## 5. Pré-requisitos do plano (c)

Para cada item: o que existe hoje, o que cabe no ADE e o que exige componente novo.

| Pré-requisito | Hoje | Cabe no ADE | Componente novo |
|---|---|---|---|
| Host dono de arquivos e provedores | o processo Tauri é o dono (AMBIENTES_REMOTOS.md:11-15). `--headless` esconde a janela, mas ainda cria o Tauri e pula serviços (run.rs:20-26, 46-54) | a lógica de runs, PTYs, banco e credenciais já está no crate | processo de host sem janela e separação da ponte com a interface (§7) |
| RPC versionado | `PROTOCOL_VERSION = 1` com igualdade na CLI (protocol.rs:135; cli.rs:1587). Métodos são strings no `match`, sem metadado (dispatch.rs:99-348) | o `match` pode virar tabela de métodos com classe, capacidade e versão mínima | registro de métodos, negociação de capacidades e versão de contrato |
| Identidade por ambiente | token por processo (server.rs:66). PID no canal de credencial (transport.rs:252) | o PID serve para o local | identidade de dispositivo (par de chaves, com a privada no keyring do cliente) |
| Pareamento e revogação | não existe. O cliente é um processo do mesmo usuário | nada | convite de uso único com prazo, tabela de dispositivos e revogação imediata. Exige schema novo, fora deste trabalho |
| Autorização por método e workspace | só a negação de manutenção (dispatch.rs:86), o papel Dreamer (policy.rs:107-119) e o PID de ancestralidade (session.rs:172-211) | a tabela de classe por método (Anexo A) e a checagem no despachador, com negação por padrão | capacidades (`session.observe`, `files.write`, `terminal.execute`, `approval.decide` etc.) e escopo por workspace |
| Proteção de rede | só loopback (server.rs:63) | o bind já existe | TLS com identidade de peer, limites por cliente e proteção contra replay |
| Logs e auditoria | `approval_audit.rs` registra aprovações de frota e de chat (approval_audit.rs:1-14). O IPC não registra pedidos (server.rs:287-289) | o registro de aprovações é o modelo | registro por principal, método e resultado, sem argumentos nem transcript |
| Expiração de sessões | `ADE_SESSION` por aba (COMPUTER_USE_SUPERFICIES.md:28). Segredos com prazo de 24 h (CLI_MCP.md:67). O token do IPC não expira | sessões de aba e segredos | prazo e renovação para clientes remotos |
| Modo somente leitura | papel de lead com `read_only` (runs/agents.rs:115-155) e poder `Read` no MCP (CLI_MCP.md:61). Ambos por agente, não por cliente | a política de papel | modo somente leitura por principal, aplicado no despachador |
| Reconexão | a CLI tem `retryable` (transport.rs:24-41). Só o chat tem `client_request_id` (CLI_MCP.md:55). O IPC não deduplica por `request_id` | o padrão de `client_request_id` | `request_id` com deduplicação para todo método que muda estado, e cursor de eventos |

## 6. Achados de segurança (f)

Severidade: **Alta** (explorável sem privilégio extra e quebra uma barreira humana), **Média**, **Baixa**, **Informativo**.

| ID | Sev. | STRIDE | Achado | Evidência | Estado |
|---|---|---|---|---|---|
| F-01 | **Alta** | E, R, I | `approval.decide` e `approval.list` não conferem quem chama. Quem tem o token aprova ou nega qualquer pedido pendente e, com `--remember`, grava regra persistente. `approval.list` devolve `task_id` e o `input` bruto. A interface não usa o IPC para isso: decide pelo comando Tauri `run_decide_approval` | missions.rs:554-572; runs/mod.rs:1192, 1203-1230, 1232, 1237; runs/broker.rs:39-50; dispatch.rs:346-347; src/features/runs/ipc.ts:138 | **Corrigido** (ver §6.1). Antes: confirmado por leitura; a exploração dependia de o agente chegar ao IPC (política de shell do usuário, não verificada) |
| F-02 | Média | S, E | `taskId` vem do payload e não é provado. Quem tem o token age como outra tarefa: lê a memória aprovada do workspace dela e propõe alterações com o autor dela. Ids de tarefa com pedido pendente saem de `approval.list`; outras fontes de id não foram mapeadas | runs/orchestration.rs:202-204, 285-294; memory.rs:1179-1184, 1240-1246, 1362, 1403, 1451, 1500; runs/policy.rs:107-119 | **Corrigido** (`taskId` provado pelo PID da tarefa; ver §6.1) |
| F-03 | Média | D | Recursos antes da autenticação. (1) O teto de 256 é um orçamento só, usado pelo TCP sem checagem e pelo canal de credencial: um cliente local segura todos os slots, e o agente vê "O app fechou a conexão". (2) O pedido é lido inteiro, até 8 MiB, antes de o token ser conferido. (3) O prazo vale por leitura: um cliente que manda um byte a cada 29 s segura o slot por tempo praticamente ilimitado | server.rs:23, 27, 70, 95, 106, 255-270; transport.rs:128, 247, 257, 328 | **Corrigido** no TCP e no socket/pipe de credencial, com a ressalva do Windows (§6.1). Não medido sob carga |
| F-04 | Média (se confirmado) | I, E | Um agente com rede liberada e AF_UNIX bloqueado pode falar com o TCP do IPC, se conseguir ler `ipc.json`. A medição do Codex mostra rede externa liberada com `network.enabled = true`, e a coluna "TCP direto" ficou em "—" nessa linha | COMPUTER_USE_SUPERFICIES.md:47-57 | **Não verificado.** Medir antes de afirmar |
| F-05 | Baixa | I | O handshake é escrito com a permissão padrão do processo e só depois recebe `0600`. Na janela, outro usuário com acesso à pasta pode ler o token. `~/.ags` e `~/.ags/ipc` não têm modo `0700` explícito | server.rs:126-145 (escrita em 132, `chmod` em 137); transport.rs:231-241 | **Corrigido** (`0600` atômico, pastas `0700`; ver §6.1) |
| F-06 | Baixa (Média se o listener ganhar HTTP) | S, T | O IPC não confere `Host` nem `Origin`. Hoje a proteção vem do formato e do token. A checagem existe em `util::loopback_trust`, usada pelo proxy de preview | server.rs:267-270; util/loopback_trust.rs:38-66; preview/proxy.rs:208-213 | Confirmado. Guarda de formato criada (§9). Checagem de Host/Origin **não implementada**, conforme o pedido |
| F-07 | Baixa | S, T, I | A CLI aceita o handshake apontado por `AGS_HANDSHAKE` ou `CONTROLCODE_HANDSHAKE` sem checar a origem. Quem define o ambiente do agente manda comandos e argumentos a um listener escolhido por ele. O token real não sai, porque a CLI usa o token do arquivo apontado | protocol.rs:61-73 | **Corrigido** (origem, nome e PID vivo validados; ver §6.1) |
| F-08 | Baixa | — | Ordem de arranque: o thread `wal-checkpoint` é criado (run.rs:81) antes de `path_env::configure` (run.rs:89) e de `export_instance_env` (run.rs:92), que chamam `set_var`. Os `SAFETY` (server.rs:41-46) exigem um thread só. Sem falha observada | app/run.rs:81, 89, 92; database/wal.rs:49-50 | **Corrigido** (ordem de arranque; ver §6.1) |
| F-09 | Média (local); **Alta** se exposto | E, T, I | Sem autorização por método. O despachador não confere quem chama. Verificado: `tab.send` escreve texto em qualquer aba por id, sem checagem (`pty_id_for_tab` também não confere). `tab.output` lê o terminal. Os demais métodos não foram auditados um a um | dispatch.rs:85-349; ipc/commands/tabs.rs:66-74, 746-756 | **Parcial**: só `tab.send` tem escopo. O resto do despachador segue sem autorização por método (§6.1) |
| F-10 | Baixa | I, E | Named pipe do Windows sem DACL explícita: a criação passa atributos de segurança nulos e conta com o padrão do token. `PIPE_REJECT_REMOTE_CLIENTS` impede o acesso pela rede | transport.rs:283, 288 | **Não verificado** (sem Windows nesta análise) |
| F-11 | Informativo | S | O token vale enquanto o processo vive, sem expiração nem revogação. Aceitável localmente; insuficiente para o host remoto | server.rs:66, 234-242 | Confirmado |
| F-12 | Informativo (controle que funciona) | — | Métodos com PID (`authorize` e `authorize_actor`) são recusados no TCP quando a ancestralidade é exigida, que é o caso em macOS, Linux e Windows (`ancestry_required`). `secret.consume` sai só por esse canal. A recusa da CLI (cli.rs:1007) é conveniência | terminal/session.rs:85-92, 172-211; ipc/commands/agent_secrets.rs:13-21, 83-88 | Confirmado por leitura |

### 6.1 Detalhes e correções sugeridas

Nenhuma correção foi implementada. Todas mudam o comportamento do IPC ou do transporte e pedem OK.

- **F-01 (alta) — corrigido.** A proteção da frota é o broker. O Claude roda com `--permission-mode default` e `--permission-prompt-tool` (runs/agents.rs:115-150). O Bash só passa sem pergunta se a política do usuário liberar. Nas abas de terminal, quem decide é a política do próprio agente.
  - **O que ficou.** `approval.decide` **e** `approval.list` são recusados **sempre**, para qualquer chamador do IPC (`ipc::person_only_error`, chamado no começo de `dispatch`, antes do token de tarefa, do PID e do banco; a CLI recusa antes de abrir a conexão). Os braços e os handlers saíram do despachador. A tela segue decidindo pelo comando Tauri `run_decide_approval`, que não mudou de contrato. O núcleo que decide (`runs::decide_from_screen`) é **privado** e o `broker` também: o IPC nem compila uma chamada a ele. `--remember` só existe na tela.
  - **Por que fechar sempre, e não por PID.** O que o servidor verifica é o PID do par, e isso prova no máximo que o chamador **é** descendente de um PTY, conversa ou tarefa da ADE, nunca que **não é** agente: um `setsid`, um duplo fork ou `open -a Terminal` sai da árvore; o TCP não traz PID; o token está num arquivo legível pelo mesmo usuário; `ADE_TAB_ID` e `taskId` são declarados pelo chamador. Sem prova de que quem chama é a pessoa, a regra é recusar, como já se faz com `memory.compact` e `workspace.restore` (`AGENT_MAINTENANCE_DENIED`).
  - **`approval.list`.** Também fechado: ele devolvia `task_id` e o `input` bruto (o comando que outro agente quer rodar), e nenhum fluxo de agente depende dele (skill, MCP e `cliBridge.ts` não o usam). A tela lista pelo comando Tauri `run_pending_approvals`.
  - **Custo.** Sem tela (CI, `--headless`), não há mais resposta pela CLI: o pedido vence e é negado; o caminho é escrever regras de permissão da pasta antes (HEADLESS.md).
  - **Fora do escopo (não alterado).** `peer.answer` e `fix.decide` ficaram para a revisão seguinte; a regra de cada um está no fim de §6.1.
- **F-02 (média) — corrigido.** *Proposta original:* ligar `taskId` ao processo, como `ADE_SESSION` (token por tarefa conferido com PID). Ou exigir o canal com PID nos métodos `memory.*`, como já fazem os de `missions.rs` (`authenticated_tab`, missions.rs:182-395).
- **F-03 (média) — corrigido.** *Proposta original:* orçamento separado por canal. No TCP, teto de tempo total por conexão (não por leitura) e teto para a primeira linha. Fechar o TCP para clientes novos quando a CLI puder usar o canal de credencial.
- **F-04 (média, não verificada).** Medir o TCP direto com `network.enabled = true`, num servidor de loopback descartável, sem rede externa. Sem OK, o sandbox não é mexido.
- **F-05 (baixa) — corrigido.** *Proposta original:* criar o temporário com `create_new` e modo `0600` antes de escrever. Criar `~/.ags/ipc` com `0700`.
- **F-06 (baixa).** Se o listener aceitar HTTP um dia, aplicar `util::loopback_trust::check` no mesmo ponto do parse. A guarda de formato (§9) impede que isso aconteça por acidente.
- **F-07 (baixa) — corrigido.** *Proposta original:* aceitar `AGS_HANDSHAKE` só se o caminho estiver em `ags_home()/ipc/`, e conferir que o PID do arquivo está vivo.
- **F-08 (baixa) — corrigido.** *Proposta original:* chamar `export_instance_env` e `path_env::configure` antes de `spawn_wal_maintenance`, ou trocar `set_var` por `Command::env`.
#### Correções de F-02, F-03, F-05, F-07, F-08, F-09 (parcial), `peer.answer` e `fix.decide`

Nada disto abre o IPC à rede (o bind e o transporte ficam como estavam; as guardas de §9 seguem passando). Código novo: `ipc/guard.rs` (predicados puros), `ipc/intake.rs` (vagas e leitura do pedido), `terminal/session.rs` (`authorize_task`, `classify_caller`).

- **F-02 — `taskId` provado.** O supervisor registra o PID do processo do agente ao lançar a tarefa (`terminal::register_task_process`, solto ao sair). O despachador, **antes** da política da tarefa e do banco, exige que todo pedido com `taskId` venha de um cliente do canal de credencial que seja esse processo ou descendente dele (o `ags mcp` do agente é). Vale para todos os comandos, inclusive `run.approve`. Id inventado, tarefa que já saiu, cliente de outra árvore (outra tarefa, aba, a pessoa) e TCP sem PID são recusados. Fluxo legítimo: o `ags mcp --task <id>` é filho do agente e usa o socket, então segue igual. **Limites:** (1) nos Unix sem API de PID do peer o `taskId` continua só declarado (o mesmo fallback explícito de `authorize`); (2) o `tabId` dos comandos `run.*` e o `from` dos demais continuam declarados (F-09 abaixo); (3) uma tarefa que perdeu o registro (o app reiniciou) deixa de provar, e ela já é órfã nesse caso.
- **F-03 — antes do token.** (a) Cada canal tem as suas vagas (`Slots`): TCP e credencial não dividem mais o teto de 256. (b) No máximo **32** conexões por canal ainda sem token validado; depois disso o cliente é fechado sem resposta. (c) O token tem de aparecer nos primeiros **1.024 bytes** da linha (a CLI serializa `token` primeiro): só depois o resto é lido, até 8 MiB. Antes dele, no máximo essa janela sai do socket. (d) O prazo agora é **total**: 5 s para chegar ao token e 30 s no total para o resto (relógio injetável nos testes); a leitura no socket tem 5 s para devolver o controle. **Efeito colateral:** um pedido que ponha `token` depois do primeiro KiB (ordem de campos diferente, ou um corpo gigante antes dele) recebe `Token inválido`. **Ressalva do Windows:** o named pipe não tem prazo de leitura por chamada, então o prazo total só é conferido entre leituras; o teto de 32 sem token vale, mas um cliente local do pipe que não manda nada segura a vaga. Só um cliente com acesso ao pipe do mesmo usuário alcança isso. Não medi carga.
- **F-05 — handshake.** O temporário nasce com `create_new` (O_EXCL) e modo `0600` numa só chamada, depois do `remove_file` de um sobrado; não segue link plantado no nome previsível. `~/.ags/ipc` (e qualquer pasta que o handshake crie) fica `0700`, inclusive uma `ipc/` antiga em `0755`. A pasta de dados que já existia (`~/.ags`) não é mexida. No Windows nada mudou (sem modo).
- **F-07 — `AGS_HANDSHAKE`.** A CLI só usa o handshake do ambiente se, depois de `canonicalize` (links resolvidos), ele for um `<pid>.json` direto em `ipc/` da pasta de dados ou do nome antigo (`~/.controlcode/ipc`), com o PID do arquivo igual ao do nome e **vivo** (`kill(pid, 0)`; `OpenProcess` no Windows, não compilado nesta análise). Senão a variável é ignorada e vale o global. Não mudou o caso `ADE_AGS_DATA_DIR` (a instância isolada já vencia a variável).
- **F-08 — arranque.** `spawn_wal_maintenance` (o primeiro thread de `run()`) passou para depois de `rendering::configure`, `path_env::configure` e `export_instance_env`. Um teste lê `run.rs` e falha se um criador de thread voltar antes de algum `set_var`.
- **F-09 (parcial) — `tab.send`.** `tab.send` prova quem chama antes de escrever (`terminal::classify_caller`): (1) identidade declarada (`ADE_SESSION`/`ADE_TAB_ID`) tem de ser provada por token + PID (ou, numa conversa, pelo PID do motor); (2) sem identidade, o cliente tem de estar **fora** de toda árvore de PTY, conversa ou tarefa do ADE: é a pessoa no terminal dela, e segue livre; dentro delas, sem identidade (`env -i`, sandbox), é recusado; (3) um agente do ADE só escreve em **si, nas abas que o alcançam no canvas (`canvas::reachable`) e nas que ele mesmo abriu** (`tab create` com identidade provada, registrado em memória). Em outra aba: recusa com o id na mensagem. O `ADE_SESSION` deixou de atravessar a ponte do `tab create` para a interface. **O que não prova:** quem se destaca da árvore (`setsid`, duplo fork, `open -a Terminal`) ou roda num terminal próprio é indistinguível da pessoa e escreve em qualquer aba, como antes; e sem PID (TCP, CLI antiga) a chamada é recusada. As abas abertas antes de um reinício do app não têm dono registrado: o agente precisa da conexão no canvas. **Não corrigido (documentado):** o resto do despachador (§3.3, Anexo A) segue sem autorização por método: `tab.output`, `tab.close`, `portal.*`, `device.*` e os demais conferem no máximo o `from` declarado. A tabela de classe por método e a negação por padrão continuam sendo o item 5 de §11.
- **`peer.answer` — papel provado.** É legítimo do **orquestrador** do integrante (skill e `CANAL_ESTRUTURADO.md`): digita a opção no diálogo de TUI dele. Antes o servidor confiava no `from` declarado. Agora o handler usa `authorize_actor` (token + PID, ou o PID do motor da conversa) e só então confere a coroa e o alcance no canvas. Sem prova, recusa. A CLI manda `from` e `session` só do ambiente do terminal.
- **`fix.decide` — papel provado, `fix.list` aberto.** A decisão depois do teto de rodadas (aceitar com pendências, rodada extra, abortar) é do **orquestrador da missão** (a mensagem de escalonamento é a resposta do `tell` dele) ou da pessoa, pela tela (`run_fix_decide`, que não passa pelo IPC). Agora o IPC exige o chamador provado (`classify_caller`) **e** que ele seja a coroa do canvas da missão do escopo `mission:<id>` (`ipc::guard::fix_decide_error`). Recusados: integrante, orquestrador de outra missão, escopo `run:<id>` (Frota, que não tem orquestrador de terminal a provar) e quem não prova nada (inclusive a pessoa num terminal próprio: ela usa a tela). Nenhum fluxo documentado de agente foi quebrado: o MCP não tem ferramenta `fix_*` e a skill só cita o comando no contexto do orquestrador. `fix.list` é leitura e não mudou. **Custo:** a pessoa não decide mais `fix decide` pela CLI fora do ADE; decide pela tela.
- **F-10 (baixa, não verificada).** DACL explícita com o SID do usuário na criação do pipe.

## 7. PTYs, efeitos, encerramento e upgrade (d)

### 7.1 Hoje

- **Encerramento.** `shutdown_once` roda, nesta ordem: limpeza do IPC (só apaga arquivos), `kill_all_sessions` (PTYs), `sim_host::stop` e `iphone::stop_all` (app/shutdown.rs:24-32). O registro de PTYs é um `static` em memória (terminal/pty_manager.rs:109-111), e `kill_all_sessions` o esvazia e mata os grupos (pty_manager.rs:1304-1313). Um PTY não sobrevive ao processo.
- **Reinício.** No boot, `runs::sweep_orphans` marca as tarefas "rodando" como órfãs (app/housekeeping.rs:88; runs/store.rs:1482). `sweep_orphan_approvals` limpa aprovações pendentes (runs/mod.rs:1297). `conversa::store::sweep_orphans` limpa conversas (housekeeping.rs:77). Rotinas: uma entrada `missed` por horário vencido, sem catch-up (BACKEND.md:84). O broker de aprovações fica em memória (runs/broker.rs:119).
- **Upgrade.** Instalar o app mata os terminais (AGENTS.md §2.1). A CLI com protocolo diferente recusa o pedido com mensagem (cli.rs:1587-1592).
- **Headless.** `--headless` esconde a janela (run.rs:20-26) e **não inicia** a rotina agendada, a fila de mensagens entre agentes, o observador de chat, o canal estruturado nem o pet (run.rs:46-54). O IPC sobe nos dois modos (run.rs:58). Ou seja: hoje não há modo de serviço em segundo plano; há um modo sem janela com serviços a menos.
- **Ponte.** Ações que só a interface sabe fazer (criar ou fechar aba, abrir design) passam por `bridge.rs` e esperam 15 s antes de devolver erro (bridge.rs:24, 88-107). Sem janela, o erro chega depois do prazo.

### 7.2 Host sem renderer: como deve funcionar

1. **Dono único.** Só o processo host abre `data.db`, cria PTYs, lê o keyring e toca os projetos (AMBIENTES_REMOTOS.md:21). Interface, CLI e clientes são clientes.
2. **Ponte com a interface opcional.** Sem janela, cada comando que depende dela responde com erro explícito ("nenhuma interface conectada"), em vez de esperar 15 s.
3. **Serviços que não dependem de janela sobem sempre.** Rotinas, fila de mensagens, observador de chat e canal estruturado não podem depender de `--headless`. Isso corrige a lacuna de §7.1.
4. **Forma do processo.** Duas opções: (i) manter o Tauri sem janela, ou (ii) um binário de host sem Tauri, com a interface como cliente. A opção (ii) deixa o host independente da janela, mas exige mover a lógica que hoje está atrás dos comandos Tauri. É decisão para um ADR, não para este documento.

### 7.3 Encerramento proposto

- O host recusa trabalho novo ao iniciar o encerramento.
- A ação "parar host" lista as sessões ativas (PTYs, tarefas, aprovações pendentes, conversas) e exige escolha explícita: esperar até um prazo, cancelar ou encerrar mesmo assim (AMBIENTES_REMOTOS.md:94-96). Não há encerramento silencioso.
- Fechar a janela não para o host. Só o processo de serviço para.

### 7.4 Upgrade proposto

1. Baixar e verificar o novo binário (fora do escopo).
2. Entrar em modo de drenagem: sem novas tarefas, PTYs ou efeitos externos.
3. Listar o que está ativo e pedir a escolha de §7.3 à pessoa.
4. Só então trocar o binário. PTYs não sobrevivem à troca, a menos que exista um supervisor de PTY separado (componente novo, decisão à parte). A proposta não promete reanexar terminais.
5. O host novo lê o SQLite e marca os órfãos, como já faz hoje.
6. Clientes recebem "host reiniciado" com o cursor de eventos e retomam sem reenviar comandos.

### 7.5 Efeitos ativos

| Efeito | Hoje | Proposta |
|---|---|---|
| PTY de aba ou agente | `static` em memória. Morre com o processo (pty_manager.rs:109-111, 1304-1313) | dono é o host. Saída guardada como scrollback. No upgrade, pedir a escolha de §7.3 |
| Tarefa de frota | estado no SQLite. Órfã no boot (housekeeping.rs:88) | drenar. Esperar, cancelar ou encerrar. Órfã no boot |
| Pedido de aprovação pendente | broker em memória (broker.rs:119). Some no reinício (runs/mod.rs:1297) | **negar por omissão** se o host cair. É o que AMBIENTES_REMOTOS.md:52 pede |
| Rotina agendada | uma entrada `missed` no boot, sem catch-up (BACKEND.md:84) | manter. Sem rajada ao reabrir |
| Mensagem entre agentes (fila) | retoma no arranque, mas não no headless (run.rs:48) | retomar sempre, com `request_id` |
| Conversa estruturada | órfãos marcados no boot (housekeeping.rs:77) | igual |
| Efeito externo (`git push`, PR, release, toque no aparelho) | sem idempotência geral. Só o primeiro envio de chat tem fase persistida (CLI_MCP.md:55) | `request_id` e fase persistida em todo efeito. Se o resultado ficou incerto, não repetir: consultar antes |
| Espelhamento de iPhone | helper `ade-iphone-mirror` à parte, que para quando o stdin fecha (shutdown.rs:32) | parar no encerramento. Reconectar sem retomar |

## 8. Separar controle remoto do ADE de espelhamento do iPhone (e)

| | Controlar o ADE remotamente | Espelhar ou controlar o iPhone |
|---|---|---|
| Caminho | RPC versionado, JSON por linha | fluxo de vídeo (RTP/HEVC) pelo túnel CoreDevice, com entrada HID (ESPELHAMENTO_IPHONE.md:14-30) |
| Pré-requisito físico | nenhum além de alcançar o host | cabo ou Wi-Fi até o Mac que é o host |
| Capacidades propostas | `session.observe`, `session.message`, `files.*`, `terminal.execute`, `approval.decide` | `device.observe` (vídeo) e `device.control` (toque, teclado) |
| Confiança | token e capacidades do host | a confiança do aparelho continua no aparelho e no painel da ADE (AGENTS.md §2.4) |
| Risco | conteúdo de terminal e de memória | `device_action` é destrutivo (mcp.rs:1569). A captura de tela pode mostrar contas logadas |

Consequências:

- O iPhone fica **fora** dos primeiros estágios. Entra depois que houver contrato de stream e canal próprio.
- `sim.act` e `desk.act` (controle de tela do computador) também ficam fora do pacote de "ADE remoto", com capacidade própria.
- Nenhum cliente recebe o fluxo do aparelho sem a capacidade `device.observe`.

## 9. Testes de guarda e resultado

Seis testes em `src-tauri/src/ipc/test.rs`, na seção "Guardas da superfície de rede do IPC", ao fim do arquivo. Eles leem o código, como os testes de contrato do mesmo arquivo, e provam que as frases que dão a garantia continuam lá. **Não provam o comportamento de rede.**

| Teste | O que protege | Código que cobre |
|---|---|---|
| `o_ipc_so_escuta_em_loopback` | um só `TcpListener::bind`, em `127.0.0.1:0`. Nenhum `0.0.0.0`, `[::]`, `UNSPECIFIED` ou `UdpSocket::bind` em `src/ipc`. A CLI conecta só a `127.0.0.1` | server.rs:63; transport.rs:135 |
| `o_pedido_sem_token_valido_e_recusado_antes_do_despacho` | a checagem do token vem antes do despacho. A recusa existe. O token é um UUID v4 por processo | server.rs:66, 269-270, 276 |
| `um_token_de_outra_instancia_nao_vale_aqui` | a comparação aceita só o token igual, sem prefixo nem sufixo | server.rs:31-37 |
| `uma_linha_http_nao_vira_pedido_do_ipc` | uma linha HTTP não vira `Request`, e o parse vem antes do token. É a guarda que substitui Host/Origin (F-06) | protocol.rs:137-144; server.rs:267-269 |
| `os_limites_do_canal_ficam_no_codigo` | teto de 256 conexões por canal e de 32 sem token (agora em `ipc/intake.rs`), teto de 8 MiB, janela de 1 KiB para o token e prazos totais de 5 s e 30 s | server.rs:23, 27, 95, 106, 255; transport.rs:247, 257 |
| `o_handshake_e_o_socket_de_credencial_continuam_so_do_usuario` | `0600` no handshake e no socket. `PIPE_REJECT_REMOTE_CLIENTS` no Windows | server.rs:137; transport.rs:236, 283 |

**Resultado** (executado em 2026-11-10, no worktree com as mudanças desta análise):

- `cd src-tauri && cargo test --lib ipc`: **236 passed, 0 failed**. As seis guardas passam.
- `cd src-tauri && cargo test --lib --bin ags`: lib com **2792 passed, 0 failed, 30 ignored** (ignorados já existentes no repositório; nenhum novo nas guardas). Bin `ags` com **52 passed, 0 failed**. As linhas "1 passed" do log são o teste `memory::concurrency::subprocess_writer`, que reexecuta o próprio binário; estão dentro da mesma execução da lib.
- `bun run check:test-lint`: "Lint de testes ok: 40 violação(ões) antiga(s) no baseline, nenhuma nova."
- Avisos de compilação: nenhum aponta para `src/ipc/`. Os avisos existentes estão em `approval_audit.rs`, `conversa/`, `desktop_apps/`, `floors.rs`, `notifier.rs`, `runs/store.rs`, `skills/mount.rs` e `util/test.rs`, e já estavam lá antes deste trabalho.
- Escopo do diff: só `src-tauri/src/ipc/test.rs` (acréscimo) e este documento.

**Não feito:** teste de mutação (trocar o bind em `server.rs` de propósito e ver a guarda falhar). Não toquei o bind nem em arquivo temporário; a prova de que a guarda falharia é a asserção exata sobre o texto de `server.rs`, não uma execução com a mudança.

**Não implementado:** a checagem de Host/Origin (pedido explícito; ver F-06).

## 10. O que não foi verificado

1. **Bind em runtime.** Nenhum processo do app casou com `pgrep` no momento da análise, e esta tarefa não executa a aplicação. A prova atual é estática.
2. **Windows.** Os testes `#[cfg(windows)]` não rodaram. A DACL do pipe (F-10) não foi examinada.
3. **Sandbox do Codex com rede liberada (F-04).** O TCP direto com `network.enabled = true` não foi medido.
4. **Leitura de `~/.ags/ipc.json` pelos agentes.** Depende de cada agente e da sua política de permissão. Não testado.
5. **Alcance de `approval.decide` por um agente.** Era o risco antes de F-01; agora o IPC recusa sempre. Não medi se um agente ainda alcança o IPC (política de shell do usuário), o que deixou de importar para este método.
6. **Comandos Tauri e webviews locais.** `build.rs:3` chama `tauri_build::build()` sem `AppManifest`, e `capabilities/default.json:5-7` usa `"*"`. Não confirmei se, sem o manifesto, os comandos do app ficam acessíveis a qualquer webview local, nem se o navegador nativo do painel recebe alguma ponte. Verificar em separado.
7. **Ordem de `set_var` (F-08).** Corrigida e guardada por teste de leitura de `run.rs`. Nenhuma falha chegou a ser observada.
8. **Negação de serviço (F-03).** Não medida. Não há número de latência nem de memória sob carga.
9. **CLI com `AGS_HANDSHAKE` apontando para um listener falso (F-07).** Não executado de ponta a ponta: a validação é testada em função pura, com pastas temporárias.
12. **Correções de F-02 a F-09 em runtime.** Testadas por unidade, por leitura de código e pelos contratos de `ipc/test.rs`. Não subi o app nem uma tarefa da Frota real para ver o `taskId` provado, nem medi a classificação por PID com um agente de verdade (o `parent_pid` só rodou nos testes que usam o próprio PID e PID 1).
13. **Windows.** `pid_alive` (`OpenProcess`), o `accept_windows` com `Slots` e o prazo do pipe não foram compilados nem executados aqui.
14. **Prova no macOS e Linux só pela descendência de PID.** Um agente que se destaca da árvore burla F-09 e a identidade sem `ADE_SESSION`; é o limite que F-01 já descrevia.
10. **Classificação dos 221 métodos.** Preliminar, pelo nome e pela leitura de alguns handlers.
11. **Identidade nos demais métodos.** `device.*`, `portal.*` e os outros não foram auditados um a um.

## 11. Ordem de trabalho

Só o que não muda comportamento pode seguir sem OK. O restante depende de OK explícito.

1. **Já feito, sem mudar comportamento:** as guardas de §9 e este documento.
2. **Com OK, sem risco de runtime:** medição de F-04 numa sandbox de teste, sem rede externa.
3. **Feito com OK (muda o IPC):** F-01 (`approval.decide` e `approval.list` recusados sempre) e F-02 (`taskId` provado pelo PID da tarefa).
4. **Feito com OK (muda o transporte):** F-03 (vagas por canal, teto sem token, token cedo, prazo total), F-05, F-07 e F-08, mais `peer.answer`, `fix.decide` e o escopo de `tab.send` (F-09 parcial).
5. **Fase 0 do plano (sem mudar comportamento; autorização geral por método continua pendente):** classificar cada um dos 221 métodos com auditoria por handler e transformar o Anexo A num teste que falha quando um braço novo do despachador não tem classe. Isso fecha o item "método desconhecido é negado" do plano.
6. **Decisão de arquitetura:** host com Tauri sem janela ou binário separado (§7.2). Cabe um ADR.
7. **Depois de 1 a 6:** identidade de dispositivo e pareamento (exige schema novo, com OK) e, só então, um cliente remoto mínimo.

Clientes web e mobile ficam para depois do contrato do servidor (AMBIENTES_REMOTOS.md:110). Não recebem token do IPC nem chave de provider.

## Anexo A: inventário dos 221 métodos

Classes: L leitura · E escrita comum · X executa ou controla · D destrutivo · A aprovação · S segredo · M manutenção (negada). Classificação preliminar, pelo nome e pela leitura de alguns handlers. Cada item é `método classe`, agrupado por família.

- **account**: list L
- **agent**: list L
- **app**: status L
- **approval**: decide A, list L
- **browser**: run X
- **chat**: compact X, goal E, list L, new X, open E, pending L, providers L, send X, settle E, show L, stop D, wait L
- **ci**: watch E
- **design**: approve E, approve.all E, archive D, artboard.add E, artboard.approve E, artboard.delete D, artboard.duplicate E, artboard.reject E, artboard.resize E, artboard.revert E, artboard.update E, comment E, comment.add E, comment.resolve E, create E, delete D, get L, list L, note.add E, open E, page.add E, page.delete D, page.rename E, reject E, revert E, update E, view L
- **desk**: act X
- **device**: act X, apps L, button X, clipboard X, close X, create E, key X, launch X, list L, open X, rotate X, say X, shot L, start X, swipe X, tap X, tree L, type X
- **events**: since L, wait L
- **fix**: decide A, list L
- **floor**: create E, list L
- **forge**: run X
- **gemini**: consult X, result L, status L
- **mcp**: cancel D
- **memory**: compact M, delete E, export L, get L, history L, index L, list L, open L, promoteFact E, propose E, search L, searchApproved L, suggest L, update E, usage L, workspaceHistory L
- **mission**: accept E, apply X, cleanup D, create X, efficiency L, precheck X, redeliver X, review L, run X, start X, startcheck X, status L, timings L, wait L
- **note**: create E, edit E, list L, read L, write E
- **notify**: send X
- **peer**: answer E, ask X, check L, connect E, deliver X, disconnect E, handoff X, list L, pending L, queue L, receipt L, recruit X, role E, tell X
- **pool**: create E, delete D, list L
- **portal**: act X, click X, close D, console L, create E, history L, hover X, layout L, list L, navigate X, open E, press X, reset D, screenshot L, scroll X, select X, snapshot L, type X, wait L
- **prelaunch**: list L
- **recall**: get L
- **replay**: start E, status L, stop E
- **role**: create E, edit E, list L, show L
- **routine**: create E, delete D, disable E, edit E, enable E, list L, run X, show L
- **run**: addFact E, addTask X, approve A, await L, cancelTask D, delegateTask X, factBody L, facts L, handoff X, harnessGraph L, plan X, rerouteTask X, result L, roster L, status L
- **say**: send X
- **secret**: consume S, request S, revoke D
- **sim**: act X
- **skill**: edit E, install X, list L, new E, search L, show L
- **swarm**: note E, promote E, question E, read L
- **tab**: close D, create X, list L, output L, send X, state L
- **team**: candidates L, create E, delegate X, link E, list L, role E, unlink E
- **user**: ask E
- **watch**: add E, list L, remove E, wait L
- **window**: create E, list L
- **workspace**: list L, open E, restore M, status L
- **worktrees**: list L, prune D

Totais: L 82 · E 64 · X 53 · D 15 · A 3 · S 2 · M 2 · **221**.

## Anexo B: arquivos alterados na análise original

- `docs/decisoes/HOST_REMOTO.md`: este documento.
- `src-tauri/src/ipc/test.rs`: seis testes de guarda ao fim do arquivo. Nenhuma linha existente foi alterada.
