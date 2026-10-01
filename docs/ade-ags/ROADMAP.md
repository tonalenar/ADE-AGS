# Roadmap ADE AGS

Ordem técnica. Sem datas. Cada etapa assume a anterior pronta o bastante para não inventar um segundo mecanismo paralelo.

A base é o ControlCode 1.8.7 neste fork. O mapa do que já existe está em [ARCHITECTURE.md](./ARCHITECTURE.md).

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

**Mission Runtime v0.1** em `fix/mission-runtime-v01` (concluído nesta base): launcher Windows sem `cmd.exe` para shims npm, política do lead imposta no broker e na CLI, aprovações na tela da Mission (mesma fila da Fleet), evento `cc-mission-changed`, progresso só de workers e E2E real com lead + 3 workers. Detalhe em [MISSION_RUNTIME.md](./MISSION_RUNTIME.md). Roles + Squads v0 e Handoff Structured v0 também estão concluídos nesta base. Shared Memory e Map Mode continuam pendentes.

## 6. Task Engine

Tasks com estado, dependência, retry e roteamento. Grande parte já está em `runs/` (scheduler, DAG, `run plan`, complexidade). O trabalho é alinhar o vocabulário da missão a essas tabelas, não escrever outro supervisor.

Depende de: 5.

## 7. Worktree por missão (pendente)

Hoje o worktree é por task da frota, em `~/.controlcode/worktrees`, ramo `cc/<task>`, e não se apaga sozinho. A missão precisa de um worktree cujo ciclo de vida seja o da missão, com a mesma regra: não descartar sujo.

Depende de: 5 e 6. Reusa `runs/worktrees.rs`.

## 8. MCP interno da ADE

O servidor `controlcode` em `ipc/mcp.rs` já é o MCP da app (browser, frota, git, pergunta, permissão). A ADE precisa do modelo "instala uma vez, anexa à missão ou à tab", que o próprio README lista como fase 11 e que ainda não existe. Codex já recebe task MCP, suporta orchestration e execução headless como Lead e Worker. Antigravity nativo também recebe MCP vinculado à Task. Gemini CLI é uma integração distinta e ainda não oferece essa orquestração.

Depende de: 2 (cada provider declara o estilo de MCP) e de 5 (anexar à missão). Não depende de um backend cloud.

## 9. Event Bus (unificação pendente)

Um barramento local para o que hoje são três canais separados: eventos Tauri da UI, watch/cursor do orquestrador de tabs, stream JSON da frota. Consumidores: UI, CLI, missão, mais tarde o map mode.

Depende de: 6. Sem tasks estáveis, o bus só replica evento de PTY.

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

`run_facts` já guarda fatos do run e o prompt deixa claro que são dados, não instruções. A memória proposta eleva esse mecanismo à missão e ao projeto, em SQLite local, sem serviço. Não é um índice cloud e não copia produto fechado.

**Próximo grande bloco; não implementado.** Deve separar Workspace Memory, Mission Memory e Run Facts e reutilizar o runtime/MCP existentes. O Event Bus unificado continua uma etapa separada.

## 14. Usage, custos e limites (parcial)

Claude já expõe plano e tokens. A frota já tem `budget_usd` e soma tokens quando o stream traz. Falta o mesmo contrato para os outros providers e um teto que a missão consulte antes de escalar.

Depende de: 2 e 6. Usage e custo dependem dos dados reportados pelo adapter: tokens já aparecem para Codex, mas custo por worker não tem cobertura uniforme. Não bloqueia 4.

## 15. Map mode (pendente)

Vista gráfica de missões, tasks, agentes e handoffs. Lê o event bus e o estado da missão. Não é um runtime novo e não embute código de Maestri nem de Overclock.

Depende de: 9, 10, 12 e 13. É a última porque desenhar cedo fixa um modelo que essas etapas ainda vão mover.

## Estado Antigravity

A integração nativa oferece Lead e Worker, model discovery via `agy models` e uma conta do sistema. Multi-account permanece experimental/incompleto: `supports_accounts = false`, sem routing simultâneo por conta. OAuth experimental não isola as credenciais do `agy`. Veja [ANTIGRAVITY_INTEGRATION.md](./ANTIGRAVITY_INTEGRATION.md).
