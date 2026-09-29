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

Uma missão é o objeto que hoje não existe: objetivo, pasta, restrições, estado, e o conjunto de tasks. Por baixo, reusa `runs` / `tasks` / `task_deps`. Não cria um segundo banco.

Depende de: 3. Pode andar em paralelo com 4, mas não antes de 3, porque missão escolhe conta por provider.

**v0 concluído** em `feat/mission-engine-v0`: Mission persistida em cima de `runs/`, ciclo draft → running → done/failed/cancelled, UI e E2E real. Detalhe e o que ficou fora em [MISSION_ENGINE.md](./MISSION_ENGINE.md).

## 6. Task Engine

Tasks com estado, dependência, retry e roteamento. Grande parte já está em `runs/` (scheduler, DAG, `run plan`, complexidade). O trabalho é alinhar o vocabulário da missão a essas tabelas, não escrever outro supervisor.

Depende de: 5.

## 7. Worktree por missão

Hoje o worktree é por task da frota, em `~/.controlcode/worktrees`, ramo `cc/<task>`, e não se apaga sozinho. A missão precisa de um worktree cujo ciclo de vida seja o da missão, com a mesma regra: não descartar sujo.

Depende de: 5 e 6. Reusa `runs/worktrees.rs`.

## 8. MCP interno da ADE

O servidor `controlcode` em `ipc/mcp.rs` já é o MCP da app (browser, frota, git, pergunta, permissão). A ADE precisa do modelo "instala uma vez, anexa à missão ou à tab", que o próprio README lista como fase 11 e que ainda não existe. Gemini e Codex hoje nem recebem o servidor atual.

Depende de: 2 (cada provider declara o estilo de MCP) e de 5 (anexar à missão). Não depende de um backend cloud.

## 9. Event Bus

Um barramento local para o que hoje são três canais separados: eventos Tauri da UI, watch/cursor do orquestrador de tabs, stream JSON da frota. Consumidores: UI, CLI, missão, mais tarde o map mode.

Depende de: 6. Sem tasks estáveis, o bus só replica evento de PTY.

## 10. Handoff estruturado

`run.rerouteTask` já troca o agente e mantém branch e worktree. Falta o pacote: objetivo, fatos, arquivos, conta, o que foi tentado, o que não pode ser refeito. Texto livre de prompt não é handoff.

Depende de: 6, 8 e 9.

## 11. Roles

Hoje só `lead` e `worker` em `runs/types.rs`. Roles da ADE (quem implementa, quem revisa, quem segura permissão) são metadado da task e do handoff, não um processo novo.

Depende de: 10.

## 12. Squads

Conjunto nomeado de providers + contas + roles que uma missão pode escalar. Não é uma frota paralela. É um filtro em cima do roster que `run roster` já calcula.

Depende de: 4 e 11. Sem multi-conta, um squad não tem o que isolar.

## 13. Shared Memory

`run_facts` já guarda fatos do run e o prompt deixa claro que são dados, não instruções. Memória da ADE é esse mecanismo elevado à missão e ao projeto, ainda em SQLite local, ainda sem serviço. Não é um índice cloud e não copia produto fechado.

Depende de: 5 e 9. Fica mais útil depois do handoff (10), que é quem precisa ler a memória certa.

## 14. Usage, custos e limites

Claude já expõe plano e tokens. A frota já tem `budget_usd` e soma tokens quando o stream traz. Falta o mesmo contrato para os outros providers e um teto que a missão consulte antes de escalar.

Depende de: 2 e 6. Números de Gemini e Codex esperam o provider saber ler o próprio stream. Não bloqueia 4.

## 15. Map mode

Vista gráfica de missões, tasks, agentes e handoffs. Lê o event bus e o estado da missão. Não é um runtime novo e não embute código de Maestri nem de Overclock.

Depende de: 9, 10, 12 e 13. É a última porque desenhar cedo fixa um modelo que essas etapas ainda vão mover.
