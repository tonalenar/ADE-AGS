# Roadmap ADE AGS

## Etapa 15 — início rápido (ponto 1)

Implementado em `feat/etapa15-inicio-rapido`: preparação persistida e idempotente de um worktree/branch por integrante (inclusive Orquestrador e recruits de missão), a partir de origin/master; junction de dependências e target Cargo isolado; contexto de precheck/memória preenchido para toda a equipe; briefing exige delegação em ~2 min antes de explorar e membros aguardam a tarefa. QG e CLI mostram `firstDelegationMs` e sua fonte real/histórica, preservando ausência em cinza. Schema v32 aditivo e testes de migração, isolamento, retry e lançamento. Comparação posterior em missão real depende de executar o app atualizado; não foi inventado ganho. Contrato e evidências em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

Ordem técnica. Sem datas. Cada etapa assume a anterior pronta o bastante para não inventar um segundo mecanismo paralelo.

A base é o ADE AGS 1.8.7 neste fork. O mapa do que já existe está em [ARCHITECTURE.md](./ARCHITECTURE.md).

## 1. Bootstrap Windows

Fundação desta etapa: fork, clone, branch `feat/ade-ags-bootstrap`, baseline de build e estas notas.

Depende de: nada no código. Fecha quando o app Windows sobe a partir deste clone e o resultado está em [BASELINE.md](./BASELINE.md).

## 2. Provider / Agent abstraction

Tornar o registry capaz de descrever um provider sem `match` de strings para o layout da conta, e fazer a descoberta de sessão receber o diretório da conta para todos os agentes de fábrica.

Depende de: 1. Não depende de Gemini instalado. Detalhe em [PROVIDER_ARCHITECTURE.md](./PROVIDER_ARCHITECTURE.md), fases A–C.

## 3. Multi-account padronizado

O mecanismo atual (diretório por conta, uma variável por processo, login no PTY, sem a ADE guardar segredo) passa a ser o contrato de qualquer provider com `profile`. Claude, Codex e OpenCode continuam iguais. O fallback que manda variável desconhecida para `~/.claude` deixa de existir.

Depende de: 2.

## 4. Gemini multi-account

`GEMINI_CLI_HOME` como home falso, dados em `<home>/.gemini`, sessões lidas desse diretório, marcador de login confirmado no CLI real. Kimi só entra se a mesma verificação existir.

Depende de: 3, e de um `gemini` instalado para confirmar o marcador. Sem o binário, a etapa não é adivinhada.

## 5. Mission Engine

Uma missão é o objeto persistente já implementado: objetivo, pasta, restrições, estado, e o conjunto de tasks. Por baixo, reusa `runs` / `tasks` / `task_deps`. Não cria um segundo banco.

Depende de: 3. Pode andar em paralelo com 4, mas não antes de 3, porque missão escolhe conta por provider.

**v0 concluído** em `feat/mission-engine-v0`: Mission persistida em cima de `runs/`, ciclo draft → running → done/failed/cancelled, UI e E2E real. Detalhe e o que ficou fora em [MISSION_ENGINE.md](./MISSION_ENGINE.md).

**Mission Runtime v0.1** em `fix/mission-runtime-v01` (concluído nesta base): launcher Windows sem `cmd.exe` para shims npm, política do lead imposta no broker e na CLI, aprovações na tela da Mission (mesma fila da Fleet), evento `cc-mission-changed`, progresso só de workers e E2E real com lead + 3 workers. Detalhe em [MISSION_RUNTIME.md](./MISSION_RUNTIME.md). Roles + Squads v0 e Handoff Structured v0 também estão concluídos nesta base. Shared Memory v0 está implementada e validada na PR #4, aguardando merge, com gates e E2E concluídos; Map Mode continua pendente.

## 6. Task Engine

Tasks com estado, dependência, retry e roteamento. Grande parte já está em `runs/` (scheduler, DAG, `run plan`, complexidade). O trabalho é alinhar o vocabulário da missão a essas tabelas, não escrever outro supervisor.

Depende de: 5.

## 7. Worktree por missão

**v1 concluído** em `feat/mission-review` (PR #11). Continua havendo um worktree por task isolada. A Mission ganhou um **worktree de integração**, criado na primeira entrega aceita na tela "Revisão das entregas", onde as branches aceitas são unidas sem tocar na cópia de trabalho do usuário. "Aplicar no projeto" faz um único merge da integração. Conflitos são sempre abortados e listados. Detalhes em [MISSION_ENGINE.md](./MISSION_ENGINE.md).

Pendente: resolver conflitos dentro da app e limpar a integração depois de aplicada.

## 8. MCP interno da ADE

O servidor `ade-ags` em `ipc/mcp.rs` já é o MCP da app (browser, frota, git, pergunta, permissão). A ADE precisa do modelo "instala uma vez, anexa à missão ou à tab", que o próprio README lista como fase 11 e que ainda não existe. Codex já recebe task MCP, suporta orchestration e execução headless como Lead e Worker. Antigravity nativo também recebe MCP vinculado à Task. Gemini CLI é uma integração distinta e ainda não oferece essa orquestração.

Depende de: 2 (cada provider declara o estilo de MCP) e de 5 (anexar à missão). Não depende de um backend cloud.

## 9. Event Bus

**v1 concluído** em `src-tauri/src/bus.rs`.

- **Formato:** todo evento da frota e das missões passa por um único bus, com `seq` crescente, ids de task/run/mission e os últimos 2000 eventos em memória.
- **Tópicos:** `task.changed`, `task.activity`, `task.rerouted`, `account.failure`, `approvals.changed` e `mission.changed`.
- **Leitura:**
  - `since(after)` atualiza quem chega tarde e marca `truncated` se algo já saiu do buffer.
  - `wait` bloqueia até chegar algo novo.
  - A UI recebe tudo pelo único evento Tauri `ade-event`.
  - A CLI usa `ags events since|wait`, com filtros de tópico, run, missão e task.

Os canais antigos (`cc-task-*`, `cc-mission-changed`) continuam funcionando, então as telas existentes não mudaram.

Pendente: migrar as telas para o bus e incluir o watch/cursor das tabs interativas.

## 10. Handoff estruturado

**Handoff Structured v0 = concluído.** A migration v22 adiciona `structured_handoff` e preserva `handoff` legado. Dependências diretas concluídas do mesmo Run recebem as entregas em ordem determinística, como dados delimitados e não confiáveis, com validação e limites de payload. Mission e Fleet usam o mesmo componente de visualização. Retry de Mission preserva Runs anteriores, e as entregas persistem após restart. Detalhes em [HANDOFF_STRUCTURED.md](./HANDOFF_STRUCTURED.md).

Usa o scheduler e MCP existentes; não depende de um Event Bus unificado novo.

## 11. Roles

**v0 concluído.** Roles + Squads v0 implementa oito functional roles built-in, declarativas em código, separadas de execution role (`lead | worker`). `Task.functional_role` registra a especialidade; provider/model/account são resolvidos pelo Squad e snapshotados no Run e na Task. Detalhes em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

Custom Roles e permissões universais por Role continuam fora do v0.

## 12. Squads

**v0 concluído.** Roles + Squads v0 implementa Squad persistente com Lead próprio e members que mapeiam uma Role funcional para provider/model/account. A Mission draft pode escolher Automatic, Specific provider ou Squad. O Run congela a configuração; editar o Squad afeta apenas novos Runs. Não é uma frota paralela e reutiliza o router existente.

Não inclui fallback silencioso, troca automática de modelo, scoring ou marketplace. Retry de Mission failed já está implementado, preservando os Runs anteriores.

## 13. Shared Memory

**Shared Memory v0: implementação commitada e publicada na PR #4 (`feat/shared-memory-v0`), aguardando merge, com gates e E2E real concluídos em 01/10/2026.**

`run_facts` continua sendo colaboração append-only de um Run. Shared Memory v0 adiciona Workspace Memory e Mission Memory em SQLite local, com propostas e aprovação explícita do usuário. Cada Run congela um snapshot das memórias aprovadas no início; workers e Lead recebem esse snapshot como dado não confiável. Detalhes e limites em [SHARED_MEMORY.md](./SHARED_MEMORY.md).

O E2E confirmou retry com snapshot atualizado, histórico antigo preservado, Lead e worker Codex, publicação de Fact e handoff, proposta de memória aprovada pelo usuário e persistência após restart. Banco original restaurado e evidências preservadas fora do repositório. Commits e push realizados; PR #4 aberta, ainda não mergeada. O Event Bus unificado e Map Mode continuam etapas separadas.

## 14. Usage, custos e limites (parcial)

Claude já expõe plano e tokens. A frota já tem `budget_usd` e soma tokens quando o stream traz. Falta o mesmo contrato para os outros providers e um teto que a missão consulte antes de escalar.

Depende de: 2 e 6. Usage e custo dependem dos dados reportados pelo adapter: tokens já aparecem para Codex, mas custo por worker não tem cobertura uniforme. Não bloqueia 4.

## 15. Map mode

**v1 concluído** (`MissionMap.tsx`, no detalhe da Mission). O mapa mostra:

- o Lead no topo e as tasks em camadas, conforme as dependências;
- arestas de dependência, e arestas tracejadas do Lead para tasks sem dependência;
- borda e ponto coloridos pelo status;
- agente, modelo e conta em cada task;
- o marcador ↻ em tasks que trocaram de mãos.

A ferramenta que cada agente está usando agora vem ao vivo de `task.activity` no bus. Não é um runtime novo: lê as tasks do detalhe e o bus.

Pendente: zoom e pan para missões grandes, e uma visão da frota inteira fora de uma Mission.

Depende de: 9, 10, 12 e 13. É a última porque desenhar cedo fixa um modelo que essas etapas ainda vão mover.

## Ao vivo no BotPanel

**v0 implementado em feat/etapa9-ao-vivo:** quinta aba com arcade de uma missão, andares derivados de tarefas, tempos e revisões, dependências reais, sprites ligados à atividade sustentada e placar que marca dados ausentes como não medidos. O canvas pausa quando oculto, respeita movimento reduzido e não emite áudio. Escopo e fontes em [LIVE_ARCADE.md](./LIVE_ARCADE.md).

**v1 implementado:** barris só com obstáculos medidos (aprovação pendente, falha/teste, memória sem resposta, peer ask expirado) e troféu de integração; PR/CI seguem "não medido".

**v2 implementado:** visão unificada (um fliperama por missão em execução) com seletor TODAS | missão. Pendente futuro: persistir `peer ask` em aberto para virar barril ao vivo.

**v3 (Etapa 12) implementado em feat/etapa12-v3-*:** um herói por terminal (sprite por plataforma, cor por papel) que anda de verdade pelas vigas e sobe escadas até o andar da etapa; a fase vira construir a torre (um bloco por tarefa concluída, PR/CI em cinza "não medido"); barris rolam pelas vigas e travam o herói afetado. Detalhes em [LIVE_ARCADE.md](./LIVE_ARCADE.md).

## Etapa 10 — entrega em terminais (ponto 5)

**Implementado:** finalizar uma missão em terminais registra o resultado dos testes informado pelo usuário e, se houver PR, consulta os checks com `gh` em modo somente leitura. Só testes aprovados com CI verde (ou sem PR) recebem `done`; os outros casos ficam separados como `done_without_delivery`. A migration v27 preserva todos os estados históricos. Detalhes em [MISSION_DELIVERY.md](./MISSION_DELIVERY.md).

## 16. Grade de recruits no canvas

**Ponto 1 concluído.** Recruits adicionados por `ags peer recruit` seguem as duas linhas da grade da missão e ocupam a próxima célula livre sem mover panes existentes. Detalhes em [RECRUIT_GRID.md](./RECRUIT_GRID.md).

## 17. Taxa de sucesso das missões (Etapa 10)

Etapa voltada a prevenir e classificar falhas de ambiente e duplicatas históricas:
- **Ponto 4 (Evitar missão duplicada):** implementado em `feat/etapa10-p4-duplicada`. Detecção de duplicatas com mesmo título e objetivo normalizados, em andamento (`running`) ou recente (24h). Bloqueio preventivo no backend (`start_now` / `start` salvo com flag `--force`) e aviso na interface (`DuplicateMissionDialog` em `MissionsPage` e `MissionsSection`, alerta em `MissionDialog`). Detalhes em [MISSION_SUCCESS.md](./MISSION_SUCCESS.md).

## Estado Antigravity

A integração nativa oferece Lead e Worker, model discovery via `agy models` e uma conta do sistema. Multi-account permanece experimental/incompleto: `supports_accounts = false`, sem routing simultâneo por conta. OAuth experimental não isola as credenciais do `agy`. Veja [ANTIGRAVITY_INTEGRATION.md](./ANTIGRAVITY_INTEGRATION.md).

## 10. Taxa de sucesso das missões

Ponto 1: precheck de instalação, sessão, catálogo por conta e limite antes do lançamento. Ver [MISSION_SUCCESS.md](./MISSION_SUCCESS.md).

Ponto 1, revisão QA: aviso de erro traduzido na lista de missões e bloqueio preventivo quando a conta principal não está exposta no roster.
Ponto 2: failover opcional por autenticação, modelo ou saldo no mesmo pool/TUI, com uma troca por task, cooldown e auditoria traduzida. Ver [MISSION_SUCCESS.md](./MISSION_SUCCESS.md) e [POOL_FAILOVER.md](./POOL_FAILOVER.md).
## 17. Classificação de falhas (Etapa 10, ponto 3)

**Implementado:** classificação tipada e persistida no fechamento (`failureClassification` + `failureDetail`), exposta por `mission_list`, `mission_get` e pelos resumos da CLI. O Frontend mostra causa e ação no QG e no detalhe da missão. Ver [MISSION_FAILURES.md](./MISSION_FAILURES.md).
## 17. Taxa de sucesso das missões (Etapa 10)

**Ponto 6 (medição) implementado no front:** cartão com histórico, 7 e 30 dias, canceladas à parte e missões de teste/E2E por marcação explícita (`isTest`). Pendente: backend gravar `isTest`. Detalhes em [MISSION_SUCCESS.md](./MISSION_SUCCESS.md).

Ponto 6, backend: marcação explícita `isTest` na criação/início (CLI `--test`), persistida no schema v27 e exposta em lista/detalhe/status, sem inferência por título. Migração preserva status e classifica legadas como reais.

## Etapa 11 — eficiência entre agentes, ponto 1 (agente parado)

**Implementado:** detector de "recebeu tarefa e ficou quieto". O backend emite `cc-peer-message` em cada `peer tell`/`peer ask`; o watcher abre uma tarefa pendente quando o orquestrador faz `tell` a um membro e a fecha quando o membro manda qualquer mensagem. Passado o plazo sem saída (120 s), o orquestrador recebe um aviso com nome, tempo parado e última linha da tela. Sem aviso se o agente escreve (pensando), se há diálogo de aprovação na tela ou se o usuário digitou na aba. Ver [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 11 — eficiência entre agentes, ponto 2 (peer ask)

**Implementado:** prazo inclui preparação/envio; `peer check` consulta status e resposta parcial da última pergunta sem repetir o pedido. `mission timings` apresenta ranking de gargalos por agente a partir de `peer_ask` e `turn`. Turnos após o briefing também são registrados, com dono único e preservação de `detail: "briefing"`. Eventos de comunicação do ponto 1 são reutilizados por destino, inclusive em batch/recruit. Detalhes e limites de inferência em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).
## Etapa 11 — Eficiência entre agentes

**Ponto 3 implementado:** ao criar o worktree, a app prepara a junction de `node_modules` no Windows ou symlink em Unix, sem substituir diretórios existentes; falhas geram aviso sem bloquear o recruit. O briefing inicial inclui caminho, shell e comandos de validação, com `cargo test --lib` filtrado. O target Cargo compartilhado é configurável como `per-worktree` para evitar disputa de lock entre agentes simultâneos, com o custo de recompilar dependências uma vez por worktree. O procedimento multiplataforma está em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).
## Etapa 11 — eficiência entre agentes (P4)

**Ponto 4 implementado:** o QG e o painel da missão mostram tempo ativo sem sobreposição, tempo de relógio, custo reportado pelos Runs, agentes observados e comparação com até 30 missões concluídas do workspace, agrupadas por faixa de agentes. O briefing só recomenda recrutar quando o trabalho é independente e paralelizável e há expectativa de terminar mais rápido do que com um agente só. Métricas, limites e API estão em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md); a linha de base anterior do QA está em [AGENT_EFFICIENCY_BASELINE.md](./AGENT_EFFICIENCY_BASELINE.md).
## Etapa 11 — eficiência entre agentes (ponto 5)

**Menos conversa, mais memória:** o briefing consulta os registros existentes antes de perguntar; integrantes enviam uma única entrega final com resultado, decisões, arquivos, testes e bloqueios. Handoff Structured permanece como registro de entrega entre Tasks do Mission Runtime; Shared Memory guarda somente conhecimento aprovado e duradouro. Detalhes e comparação estática de tokens em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 13 — Squad: subagente padrão e modo Fast (ponto 1: Fast)

Implementado em `feat/etapa13-1-fast`: schema v30 (`fast_mode` em `squads`/`squad_members`), interruptor "Modo Fast" só para Codex na tela de Squad (pt-BR/en/es), `withModel`/`recruitCommand` com `-c service_tier=fast` e `ags peer recruit --fast`. Detalhes em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

### Etapa 13 — ponto 2 (subagente padrão do Squad)

Implementado em `feat/etapa13-2-subagente` (empilhada em `feat/etapa13-1-fast`): schema v31 (`subagent_*` em `squads`), campo `defaultSubagent` no Squad (Automático ou agente + modelo + esforço + Fast), seção na tela de Squad (pt-BR/en/es), validação e testes. O uso no `ags peer recruit` e no briefing vem no ponto 3.

### Etapa 13 — ponto 3 (uso no recruit e no briefing)

Implementado em `feat/etapa13-3-recruit-padrao` (empilhada nas anteriores): `ags peer recruit` sem `--model`/`--effort` usa o subagente padrão do Squad da missão em execução (explícitos vencem; Automático/sem Squad = comportamento atual), briefing do orquestrador mostra o padrão ativo ou manda justificar a escolha, skill `ags-orchestrator` 1.26.0 e help da CLI atualizados. Detalhes em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

## Etapa 14 — unificar o tempo ativo

Fonte única em `missions/active.rs`: `mission_active` positivo → união de spans `turn`/`peer_ask` → relógio de parede com `started_at` → não medido. Lista, QG, painel de tempos, `ags mission efficiency`/`timings` e medianas históricas por faixa de agentes usam a mesma duração e identificam sua fonte. Spans permanecem como detalhe por turno (`turnMs`) e gargalos. Sem migração nem alteração de dados antigos.

A fotografia somente leitura do banco real mostrou cobertura de 9/47 missões em `mission_active` e 20/47 em spans; na missão `f754b31f`, 4.322 s contra 28 s. Semântica, limitações, comparação e contratos em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md); integração com a seção Tempos em [MISSION_TOKENS.md](./MISSION_TOKENS.md#tempo-ativo-da-missão). A validação inclui escolha de fonte/fallback e consistência entre lista, eficiência e tempos nos três caminhos.

## Etapa 15 — Início rápido, Ao vivo que funciona e abas

Cinco pontos de melhoria estrutural focados na velocidade de inicialização das equipes, segurança operacional e visibilidade em tempo real.

### Ponto 1 — Início rápido da missão
- **Problema:** O boot de terminais levava de 5 a 11 s, mas o primeiro turno dos agentes demorava de 7 a 13 minutos (Etapa 14: Frontend 488 s, Orquestrador 421 s, QA 800 s; primeiro peer ask do orquestrador apenas aos 701 s, que expirou). O atraso vinha do orquestrador explorando código antes de delegar, membros explorando/editando por conta própria antes de receberem tarefas e múltiplos agentes dividindo o mesmo worktree concorrentemente ("Backend já está editando o Rust neste worktree").
- **Implementado:**
  1. Métrica "tempo até a primeira delegação" (`spans`/`peer_message`) visível no QG do bot e na CLI `ags mission timings`.
  2. Protocolo de briefing estruturado: orquestrador elabora plano conciso e delega a cada integrante em até ~2 minutos antes de realizar exploração profunda; briefing dos integrantes proíbe exploração ou edição prévia à tarefa.
  3. Worktree e branch dedicados por integrante no início da missão, reaproveitando a infraestrutura de `floors.rs`/setup da Etapa 11 (junction de `node_modules` no Windows e `CARGO_TARGET_DIR` isolado `per-worktree` para evitar disputa de lock do Rust). O briefing informa o caminho exato e a branch do integrante.
  4. Pré-preenchimento no briefing com as informações apuradas pelo precheck e pela Shared Memory, eliminando buscas redundantes. Redução medida do primeiro turno de 7-13 min para ~2 min.
- Detalhes e contratos em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

### Ponto 2 — 'X' nas abas de missão
- **Implementado:** Botão de fechamento ('X') integrado diretamente nos chips/abas de missão no topo da interface (`MissionChips.tsx`).
- **Segurança operacional:** Fechamento com verificação de estado (`closeMissionNeedsConfirm` em `groups.ts`). Missões em andamento (`running`) exibem diálogo de confirmação com aviso de encerramento de processos/terminais dos agentes (`missions.chips.closeTitle`, `missions.chips.closeBody`). Missões já concluídas, canceladas ou sem processo ativo fecham imediatamente sem diálogo redundante.
- Suporte a i18n completo (pt-BR, en, es).

### Ponto 3 — Ao vivo que funciona para missões em terminais
- **Problema:** No arcade do QG do bot (`LiveArcade`), heróis ficavam estáticos na viga inferior ("equipe") porque missões em terminais não utilizam tarefas clássicas de DAG/Run. O HUD de "Tempo ativo" exibia "não medido" mesmo com a missão em execução.
- **Implementado:**
  1. Derivação de andares e estados através de sinais reais de terminais e papéis: Abertura (briefing/aguardando), Trabalho (saída sustentada em terminal), Testes (papel QA/testes), Revisão (papel revisor) e Entrega (conclusão).
  2. Animação e movimentação física: heróis andam pelas vigas e sobem/descem escadas reais nas mudanças de andar; patrulham durante saída sustentada, dormem (`Z`) quando inativos e assumem alerta (`!`) em bloqueios ou esperas.
  3. Blocos da torre erguidos na entrega final de cada integrante (`peer tell` padronizado de encerramento).
  4. Barris estritamente atrelados a fontes reais (aprovação pendente, checks falhando, memórias pendentes, peer ask expirado).
  5. HUD "Tempo ativo" alimentado pela fonte unificada da Etapa 14 (`activeSeconds` e `activeSource`), refletindo tempo ativo real sem exibir "não medido" em missões ativas; sem dados disponíveis permanece cinza.
- Detalhes visuais e contratos em [LIVE_ARCADE.md](./LIVE_ARCADE.md).

### Ponto 4 — Logos em pixel art na legenda
- **Implementado:** Substituição do antigo marcador quadrado por ícones pixel-art 12x12 de cada plataforma (Claude, Codex, Antigravity, Gemini, OpenCode e genérico) ao lado do status do agente na legenda do Ao Vivo.
- Desenhados programmaticamente via Canvas/CSS sem uso de imagens externas ou assets adicionais.

### Ponto 5 — Modo abas com panes lado a lado em grade
- **Implementado:** Na visualização de abas da missão (ao lado de Canvas), opção para dispor todos os panes lado a lado em grade.
- Configuração individual por missão/aba, persistida localmente (não global), mantendo a visualização tradicional empilhada/tabulada como padrão.
- i18n completo (pt-BR, en, es) e testes dedicados.

## Etapa 15 — abas de missão, Ao vivo e grade (Frontend)

- [x] X nas abas de missão do topo, com confirmação se a missão está em andamento.
- [x] Ao vivo derivado dos sinais dos terminais (andar, escadas, patrulha, `!`, bloco por entrega final), HUD com a fonte unificada.
- [x] Logos pixel-art 12x12 na legenda.
- [x] Modo grade (todos os panes lado a lado), individual por missão e persistido.


## Etapa 16 — orquestração confiável

- [x] Detector de **orquestrador parado** (`missions/leadStall.ts`): integrante pediu algo (`peer ask`, `peer tell` com `?`, ou pergunta na tela) e o orquestrador não respondeu em 3 min (`LEAD_STALL_MS`, configurável em `localStorage["ags.leadStallMs"]`, mínimo 30 s). Aviso no terminal do orquestrador (`pasteIntoTab`), alerta no QG e na aba da missão, span `orchestrator_stall`.
- [x] **Teste de início de missão**: eventos `start_briefing`, `start_activity`, `start_retry`, `start_stalled` e `start_all_working` (tempo até todos trabalhando, exibido no QG) gravados em timings; verificação de 2 min (`START_DEADLINE_MS`).
- [x] `ags mission timings` e `ags mission startcheck <id>` (Backend).

## Etapa 16 — métricas e verificação do início (Backend)

`ags mission startcheck <id>` consulta briefing, atividade, retries e avisos por integrante, incluindo quem nunca iniciou, e verifica o limite de 120 segundos desde a abertura dos terminais. `ags mission timings` expõe contagem de alertas, espera total/máxima do orquestrador e tempo até todos trabalhando. Reutiliza `mission_timings` e a equipe persistida; nenhuma migração necessária. A instrumentação de atividade, retry e alertas fica no frontend; o comando não envia Enter nem altera terminais. Contrato em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 18 — Canvas de Design: pranchetas, comentários e aprovação

- [x] **Backend**: designs, páginas, pranchetas (HTML, tamanho, posição, versão, status), histórico de versões e comentários, em tabelas aditivas e idempotentes; comandos IPC `design_*`, evento `design-changed` e CLI `ags design`. Detalhes em [DESIGN_CANVAS.md](./DESIGN_CANVAS.md).
- [x] **Frontend**: painel Design no canvas (zoom/pan, páginas, iframe em sandbox, modo EDIT, comentários por elemento, versões, aprovar/rejeitar/aprovar tudo, atualização ao vivo).
- [x] **Fluxo de construção**: só pranchetas aprovadas viram tarefas (`buildTasks.ts`); briefing do orquestrador e skill `ags-orchestrator` 1.27.0 com "desenhe primeiro, aprove, construa".
- [ ] Fora do escopo (etapa seguinte): preview real do app em dev server por worktree; compartilhar link.

## Etapa 19 — Design no canvas principal e acabamento (Backend)

- [x] Posicionamento automático de pranchetas novas; arraste preserva aprovação/versão e desfazer preserva posição.
- [x] Dedupe de designs por missão/título, consolidação sem perder propostas existentes (v37), aliases dos IDs antigos, arquivar e excluir via Tauri/CLI.
- [x] Dono pela aba criadora (`from`/`ADE_TAB_ID`); evento distingue design novo de reuso.
- [x] Identidade do build em `ags --version` e comparação do CLI adjacente com a app, com limite de tempo e testes.
## Etapa 19 — Design no canvas principal e acabamento

- [x] **Design no canvas principal (Frontend)**: pranchetas dispostas diretamente como nós do canvas com molduras agrupadas por página/design (`layoutGroups`), origem livre à direita (`freeOrigin`), foco automático e enquadramento (`fitViewport`).
- [x] **Aviso de novo design e foco (Frontend)**: detecção de designs recentes não vistos (`freshDesigns`), exibindo toast interativo com ação rápida de "Abrir" para focar imediatamente o nó criado pelo agente.
- [x] **Dedupe, Delete e Archive (Backend/Frontend)**: migração v37 consolidando designs duplicados e adicionando índices únicos (`mission_id, title` e `workspace, title`) com preservação de páginas, comentários, versões e mapeamento de aliases legados; comandos e UI para exclusão total (`design_delete`) e arquivamento (`design_archive`).
- [x] **Posicionamento e arraste (Backend/Frontend)**: pranchetas em (0,0) espalhadas automaticamente (`spreadOverlapping`); arraste de prancheta separa movimento (x, y) de edição de conteúdo, preservando aprovação e versão sem inflar histórico de snapshots (`positionsToSave`).
- [x] **Resolução de dono e resiliência (Backend/Frontend)**: criador identificado por `from`/`ADE_TAB_ID`, fallback para orquestrador da missão quando a aba for fechada, e badge informativo com tratamento gracioso de ações quando sem dono ativo.
- [x] **Detecção de CLI desatualizado (Backend/Frontend)**: checagem de build/hash entre app e binário adjacente (`cli_build_status`) e alerta proativo único por sessão (`useCliOutdatedNotice`).
- [x] **Auditoria e Regressão (QA)**: auditoria com dados reais do SQLite (`~/.ags/data.db`: design "Polir o bot - aura e acabamento" duplicado e 5 pranchetas sobrepostas em x=0, y=0), relato de defeitos reprodutíveis aos pares via `ags peer tell`, revisão analítica dos recursos de edição/comentários/desfazer/aprovação, testes de integração/regressão (`designCanvasIntegration.test.ts`) e documentação em [DESIGN_CANVAS.md](./DESIGN_CANVAS.md).

## Etapa 17 — custo, Fast headless, entregas e memória
- Custo por aba (tokens/custo por terminal da missão): ver MISSION_TOKENS.md.
- Fast nas execuções headless: ver AGENT_EFFICIENCY.md.
- Reavaliação de missões `done_without_delivery` (`ags mission redeliver`): ver MISSION_SUCCESS.md.
- Revisão das memórias sugeridas ao concluir a missão (duplicadas, contradições, alto valor): ver SHARED_MEMORY.md.

## Etapa 17 - uso por aba (Backend)

Implementado em `feat/etapa17-tab-usage`: `mission_tokens` inclui `agents[].tabs`, e `ags mission efficiency` inclui `tokens`. Soma das abas = total do agente; soma dos agentes = total da missao. Identidade persistida, sessao antes de cwd exclusivo, deltas Codex e nenhuma medicao inventada. Contrato e limitacoes: [TAB_USAGE.md](./TAB_USAGE.md).

## Etapa 17 - Fast headless (Backend)

Implementado em `feat/etapa17-headless-fast`: snapshot Fast do lead e dos integrantes persistido em runs/run_squad_members (v34); supervisor passa `LaunchCtx.fast_mode` e Codex usa `-c service_tier="fast"`. Providers sem equivalente nao recebem flags. Formatos CLI verificados, limites e testes: [FAST_HEADLESS.md](./FAST_HEADLESS.md).

- Etapa 20 (UI): ver [ETAPA_20_POLIMENTO_UI.md](ETAPA_20_POLIMENTO_UI.md) — chat (Markdown, tamanho, trazer do terminal), navegador no Canvas, scrollbars, modal único de memória.
