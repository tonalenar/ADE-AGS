# Roadmap ADE AGS

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

## 16. Grade de recruits no canvas

**Ponto 1 concluído.** Recruits adicionados por `ags peer recruit` seguem as duas linhas da grade da missão e ocupam a próxima célula livre sem mover panes existentes. Detalhes em [RECRUIT_GRID.md](./RECRUIT_GRID.md).

## Estado Antigravity

A integração nativa oferece Lead e Worker, model discovery via `agy models` e uma conta do sistema. Multi-account permanece experimental/incompleto: `supports_accounts = false`, sem routing simultâneo por conta. OAuth experimental não isola as credenciais do `agy`. Veja [ANTIGRAVITY_INTEGRATION.md](./ANTIGRAVITY_INTEGRATION.md).

## 17. Classificação de falhas (Etapa 10, ponto 3)

**UI implementada:** causa + ação sugerida no QG e no detalhe da missão. Pendente: backend gravar `failureClass`. Ver [MISSION_FAILURES.md](./MISSION_FAILURES.md).
