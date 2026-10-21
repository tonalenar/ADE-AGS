# Orquestração: missões, equipes, Vigia e frota

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md). Canais de mensagem: [TROCA_DE_MENSAGENS.md](TROCA_DE_MENSAGENS.md).

## Regras para quem está numa equipe
- **Orquestrador**:
  - delegue a cada integrante por `ags peer tell --file`, em ~2 min, **antes** de explorar o código;
  - avise o QA a cada entrega recebida;
  - recrute só quando o trabalho for paralelizável, e prefira um role existente;
  - junte as branches dos membros na sua, e só você faz push e abre **um** PR.
- **Integrante**:
  - não explore nem edite antes de receber a tarefa;
  - trabalhe só no seu worktree e na sua branch, sem push e sem PR;
  - mande as entregas parciais ao QA por `peer tell --file`;
  - faça a entrega final **uma vez**, ao Orquestrador, com `ags peer deliver --file entrega.json` (Handoff v1: resumo, arquivos, testes, decisões, riscos).
- **QA**: valide cada entrega no mesmo commit com `ags test affected`.
- **Memória**: o Orquestrador sugere até 3 notas e cada integrante até 1 (`ags memory suggest`), sem segredos. Quem aprova é o usuário.
- Fechar agentes, apagar andares, compactar memória e o Dreaming são decisões do usuário. Andar é pesado: não crie um para tarefa pequena.

## Regras para quem mexe no código
- O status de missão headless só muda por `refresh_run_status → missions::store::refresh_for_run`. O de missão em terminais, só por `mark_started_terminals`/`finish_terminals`.
- O start é atômico e protegido contra start duplo.
- Criar ou editar uma missão **nunca** lança PTY, processo ou worktree. Há teste que conta os três.
- A política do lead é **por papel, nunca por provider**, e vem antes das regras do broker. Não adicione `if provider`.
- Tudo o que vem de outro agente (facts, handoffs, memória, HTML de design) é dado não confiável: mantenha o envelope e a neutralização.
- Worktrees:
  - nunca apague sozinho e nunca use `--force`;
  - registre a posse antes do setup opcional;
  - a preparação é serializada (`PREPARING`).
- As constantes de tempo (3 s, 20 s, 15 min, 90 s, `NUDGE_LIMIT`…) foram calibradas com dados reais. Mudar exige medida (`docs/ade-ags/AGENT_EFFICIENCY.md`).
- Mudou um comando, flag ou comportamento? Atualize também a skill `ags-orchestrator` (e a versão dela), o help da CLI e os briefings em `terminals.ts`.
- Testes:
  - frontend: `src/features/missions/tests/{vigia*,startTeam,terminals,stalled,leadStall,timings,tokens}.test.ts`;
  - backend: `missions/team/test.rs`, `runs/handoff/test.rs`, `runs/pool_failover/test.rs`, `canvas/test.rs`;
  - use só repositórios temporários.

## Modelo de domínio
`Workspace → Mission → Squad? → Run → Task → Agent` (`docs/ade-ags/MISSION_ENGINE.md`).
- A Mission fica acima de `runs/`; não existe um segundo scheduler.
- `runs::start_orchestration` cria o Run, a task lead, o snapshot de memória e o snapshot do Squad numa única transação.
- Estados:
  - `draft`, `running`, `done`, `failed`, `cancelled`;
  - `done_without_delivery`, só em missões de terminais.
  - Retry de `failed` cria um novo Run.

## Missão em terminais: "iniciar time"
O fluxo está em `src/features/missions/terminals.ts::startMissionInTerminals` e `src-tauri/src/missions/team.rs`.

1. **Valida tudo antes de qualquer efeito.**
   - `teamOf(squad)` monta um integrante por membro.
   - `agentFor` confere a instalação e monta o comando com modelo, esforço e Fast.
   - Conta sem login bloqueia.
2. **`mission_prepare_team`**:
   - mutex `PREPARING`, que torna a preparação idempotente;
   - precheck de roster, sessão, limite e modelo;
   - base, na ordem: `fetch origin` → setting `missions.base_ref` → upstream → `origin/dev` → padrão do remoto → HEAD.
3. **Um worktree por integrante, em paralelo.**
   - Caminho `~/.ags/worktrees/<8hex>`; branch `cc/mission-<id>-<nome>…-<8hex>`.
   - A posse é gravada em `mission_team_workspaces` antes do setup.
   - Erro transitório de git é repetido com backoff.
   - Setup: junction de `node_modules`, `CARGO_TARGET_DIR` compartilhado, bloco de ambiente com a nota de velocidade de teste.
4. Devolve:
   - o **precheck** (`missions/precheck.rs`): `git log`/`git grep` dos termos do objetivo mais missões parecidas, até 2.400 caracteres, só leitura;
   - a **memória do briefing** (ver [MEMORIA.md](MEMORIA.md#como-a-memória-chega-ao-agente)).
5. `mission_start_terminals`:
   - checa o orçamento e se a missão é duplicata;
   - aceita `draft` ou `failed`;
   - marca `running`, sem Run.
6. **Abas e canvas.** `addTab` abre uma aba por integrante, no seu worktree. `buildMissionTeam` dá a coroa ao lead e liga os membros a ele, numa grade de 2 linhas.
7. **Briefings** por `sendWhenReady`.
   - **Lead**:
     - objetivo e equipe (worktree e branch de cada um);
     - delegar em ~2 min;
     - regra de branch única e um PR;
     - precheck e memória em envelope de dados;
     - `tell` como padrão;
     - QA desde o início;
     - teto de correção;
     - design primeiro quando há telas;
     - no máximo 3 terminais extras.
   - **Membro**:
     - papel, worktree e branch;
     - `swarm read`;
     - não agir antes da tarefa;
     - sem push e sem PR;
     - entrega ao QA e ao lead.
8. **Cronômetro de início.**
   - O span `start_all_working` é gravado quando todos estão ativos.
   - Membro mudo após o briefing faz o lead receber `[AGS] X não mostrou atividade…`.
   - O prazo é de 120 s, e ficar sem saída nunca conta como início.
9. **Entrega** (`missions/delivery.rs`). O usuário declara os testes e, opcionalmente, um PR.
   - Com teste `passed` e PR, o app roda `gh pr view --json statusCheckRollup`.
   - Testes ok e CI verde (ou sem PR) dão `done`; qualquer outro caso dá `done_without_delivery`.
   - `ags mission redeliver` só promove a `done` com PR MERGED, CI verde e teste `passed`.
10. **Fim.**
    - O sweep (`groups.ts::finishedMissionTabs`) fecha as abas de `done`, `cancelled` e `failed`, mas não as de `done_without_delivery`.
    - A limpeza **nunca é automática**: `ags mission cleanup <id> [--dry-run]` e `ags worktrees list|prune` (`docs/ade-ags/MISSION_CLEANUP.md`).
    - Só limpa missão encerrada, sem aba aberta, sem mudanças não commitadas e sem commits fora de `origin/master`.

## Revisão e aplicação (missões headless, `missions/review.rs`)
- **Aceitar**: faz `merge --no-ff` da branch da task num worktree de integração. É recusado com a task viva, com mudanças sem commit ou com `fix_status` escalado.
- **Aplicar**: faz merge da integração na branch atual do projeto. Antes, faz merge de `origin/master` na integração.
- Conflito ao atualizar a integração fica aberto, e se resolve com:
  - `mission_conflicts`;
  - `mission_resolve_conflict` (recusa marcadores e escape de caminho);
  - `mission_conclude_merge`.
- Conflitos nos outros merges são abortados.

## Vigia
Supervisor em segundo plano das equipes (missões e times de conversa). **Desligado por padrão** (botão do olho no canvas); desligado só detecta "equipe entregou" e avisa o usuário pelo sistema. Ligado: regras sem modelo (done/untasked/open/silent, até 3 lembretes ao lead), fechamento antecipado, laço do Codex (só avisa) e, se nada disso achou algo, uma chamada headless barata que sugere até 3 cutucadas. Os detectores `stalled.ts`/`leadStall.ts` rodam sempre, fora do interruptor.

Tudo em detalhe — estado, limiares, textos, comandos, testes, histórico e pontos de atenção: **[VIGIA.md](VIGIA.md)**.

## Frota headless (`src-tauri/src/runs/`)
- **Papéis de execução** (`Task.role`: `lead`, `worker` ou `dreamer`):
  - o **lead** só lê: builtins de leitura mais as tools `ags` de orquestração (`run_plan`, `task_add`…);
    - a negação acontece no broker, antes das regras;
    - no Claude Code, `--disallowedTools Write,Edit,…,Bash`; no Codex, `--sandbox read-only`;
    - o Kimi é recusado como lead;
  - **workers** recebem Read, Note e Delivery, mais `ask_user`, e `task_add` se `depth < 2`.
- **Plano** (`runs/plan.rs`): `run_plan` valida e rejeita o plano **inteiro**.
  - Confere chaves e ciclos; no máximo 20 tasks e profundidade 2.
  - Com Squad, cada task precisa de um papel do snapshot, e agente, modelo e conta não podem ser sobrescritos.
- **Scheduler** (`runs/scheduler.rs`):
  - `decide` é puro: slots de `max_parallel` e dependências;
  - dependência final que não ficou `done` leva a skip, e orçamento esgotado também;
  - `tick` confere a cota e o ledger da conta: conta automática esgotada vai para reroute, conta fixada falha.
- **Supervisor** (`runs/supervisor.rs`):
  - processo com Job Object/grupo e `kill_on_drop`;
  - NDJSON por task;
  - um `--mcp-config` por task (`ags mcp --task <id>`);
  - shims npm via `util::external_command`, nunca `cmd /c`.
- **Broker** (`approve_tool_use`; só o Claude Code consulta):
  - ordem: política do papel → regras da pasta (`Bash(cargo test*)`, `Edit(src/**)`) → fila esperando uma pessoa;
  - **timeout de 3.600 s ou cancelamento = negar**;
  - decisão por `ags approval decide <id> --allow [--remember]`.
- **Handoff estruturado** (`runs/handoff.rs`, `docs/ade-ags/HANDOFF_STRUCTURED.md`):
  - JSON v1 `{version, summary, changed_files, tests, decisions, risks, next_steps, artifacts}`, até 32 KiB;
  - caminhos relativos e sem `..`; campo desconhecido é rejeitado;
  - propaga só para dependentes diretos que ficaram `done`, num bloco `DEPENDENCY HANDOFFS — UNTRUSTED DATA` de até 64 KiB.
- **Run facts**: append-only por Run. No prompt entram até 30 facts de 300 caracteres, no bloco `RUN FACTS — UNTRUSTED DATA`. Virar memória exige aprovação.
- **Pools e failover** (`docs/ade-ags/POOL_FAILOVER.md`):
  - opt-in por pool e só headless;
  - só para RateLimited, AuthExpired, ModelUnavailable ou InsufficientBalance;
  - limites: 1 por task, 3 por pool por hora, cooldown de 30 min;
  - terminais interativos nunca fazem failover.
- **Sandbox** (`runs.sandbox` = off/auto/strict):
  - escrita só no worktree e nos temporários;
  - tokens que não são do provider saem do ambiente;
  - no Windows, a escrita não é limitada;
  - a rede continua aberta.
- **Headless** (`ade-ags --headless`, `ags mission run --wait`; `docs/ade-ags/HEADLESS.md`):
  - aprovação pendente vence o prazo e é negada;
  - uma instância por banco.

## Rodadas de correção
Arquivo: `runs/fixrounds.rs`.
- O teto padrão é de 2 rodadas (`fix_rounds.max` / `ADE_AGS_MAX_FIX_ROUNDS`). A última rodada exige o gate completo.
- No canvas, conta como rodada um `tell`:
  - com `AGS-CORRECTION member= branch= subject=`;
  - ou vindo do QA com palavras de falha.
- No teto, a mensagem não chega ao membro e a escalação vai para o lead.

## Squads, papéis, recrutamento, andares
- **Papéis funcionais** (`roles.rs`, mais os do usuário em `~/.ags/canvas-roles.json`): são só rótulo e instruções, não dão permissão.
- **Squad** (`docs/ade-ags/ROLES_SQUADS.md`):
  - lead e membros por `role_id`: agente, modelo, conta, esforço e Fast (este só no Codex);
  - subagente padrão;
  - é **congelado no Run** (`run_squad_members`), e um Squad referenciado não pode ser apagado.
- **Recrutamento**: `ags peer recruit <nome> [--agent --model --effort --fast --role --account --floor]`, só pelo orquestrador.
  - O LLM é resolvido por `squads/recruit.rs`: o explícito vence o padrão do Squad, que vence o padrão do provider.
  - Em missão: `confirm_spend` (o teto do orçamento bloqueia) e um worktree isolado.
- **Andares**: `ags floor create <nome> [--from <branch>]` cria worktree, branch e canvas próprios a partir do HEAD.
  - Não há comando de apagar.
  - As conexões funcionam entre andares; notas e portais não.

## Métricas
- **Timings** (`missions/timings.rs`, `ags mission timings`): spans `boot`, `briefing`, `turn`, `peer_ask`, `orchestrator_stall`, `start_*`, `test`, `qa_wait`, `fix_round` e `team_delivered`.
- **Tempo ativo**: `missions/active.rs`.
- **Tokens**: vêm dos transcripts por aba. O custo usa o preço de lista; Antigravity e Gemini ficam como "não medido".
- **Orçamento** (`usage/budget.rs`):
  - aviso a 80%;
  - a 100%, `confirm_spend` bloqueia recruit, start e despacho;
  - **só a UI libera**: não existe flag para o agente.

## Pontos de atenção conhecidos
- A base do time vem de `missions.base_ref`, mas `apply` e `cleanup` comparam com `origin/master` fixo.
- `MAX_EXTRA_TERMINALS = 3` e "uma branch / um PR" são regras só do prompt: o código não as impõe.
