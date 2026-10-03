# Mission Runtime (v0.1)

**Mission Engine = domínio. Mission Runtime = execução e coordenação.**

O Mission Engine ([MISSION_ENGINE.md](./MISSION_ENGINE.md)) é a Mission persistida: objetivo, pasta, preferência de lead e conta, estados. O Mission Runtime é o que acontece quando ela roda: lançar o processo do provider, fazer o lead coordenar em vez de executar, levar as aprovações até a tela da Mission e avisar a UI do que mudou.

Não há executor novo. O runtime é o mesmo `runs/` da frota: supervisor, broker, adapters, scheduler, routing, worktrees. O v0.1 corrige e reforça esse caminho; não cria outro.

Este documento registra o runtime v0.1. Roles + Squads v0 adiciona roteamento funcional ao mesmo executor e está descrito em [ROLES_SQUADS.md](./ROLES_SQUADS.md). Handoff Structured v0 também está concluído, descrito em [HANDOFF_STRUCTURED.md](./HANDOFF_STRUCTURED.md). Shared Memory v0 usa o MCP e o runtime existentes; o Event Bus unificado e Map Mode continuam etapas separadas.

## Shared Memory e Run Facts

No início de cada Run, a transação que cria Run e Lead também grava `run_memory_snapshot` e seus metadados. A seleção considera apenas revisões aprovadas do Workspace e da Mission anexada: prioridade decrescente, Mission antes de Workspace em empate, depois key e ID. O limite é de 16 entradas e 16 KiB agregados; entradas grandes são truncadas em fronteira UTF-8 e o snapshot registra truncamento e omissões. Um Run vazio também possui metadados de snapshot.

O Lead recebe o snapshot em `LaunchExtras.prompt`, separado do system prompt. Workers recebem o mesmo snapshot no prompt de contexto. O conteúdo é JSON delimitado como `UNTRUSTED DATA`; ele não pode alterar role, functional role, provider, model, conta, effort, tools, permissões, Lead Guardrail ou Squad routing. O runtime não ativa uma proposta durante um Run.

`facts_read` agora pagina Run Facts e informa cursor, `hasMore` e truncamento do preview. `fact_read` busca o corpo completo em blocos UTF-8 limitados. Run Fact continua pertencendo a apenas um Run; sua promoção é uma ação explícita que cria uma proposta de Shared Memory, sem converter o fato nem alterar o histórico do Run. Ver [SHARED_MEMORY.md](./SHARED_MEMORY.md) para o contrato e os limites.

## Roles + Squads v0

Execution role (`Task.role = lead | worker`) continua separado de functional role (`Task.functional_role = backend | frontend | qa | ...`). O primeiro controla a política de execução e o Lead Guardrail; o segundo orienta o trabalho e escolhe um SquadMember. A lista de oito Roles built-in é declarativa e não contém provider/model/account.

Mission sem Squad conserva routing/tier/complexity. Mission com Squad usa o Lead configurado no Squad e resolve cada worker pela Role do `run_plan`. O Run copia a configuração dos members ao iniciar; Tasks copiam a Role e provider/model/account efetivos. Editar o Squad não altera Runs ou Tasks existentes. O Lead não vê detalhes de roteamento e não pode sobrescrever provider/model/account em Tasks do Squad.

Start verifica a disponibilidade do Lead. Members opcionais indisponíveis não impedem o Start, mas o plano falha inteiro se usar um deles. Modelo sem informação verificável aparece como `unknown` e é checado pelo router ao planejar. O detalhe histórico mostra o nome do Squad e suas configurações snapshotadas; cada worker mostra sua Role funcional e assignment resolvido.

## 1. Launcher Windows (`util/launch.rs`)

### Causa

Codex e OpenCode instalados por npm são `codex.cmd` / `opencode.cmd`. Desde o Rust 1.77 (CVE-2024-24576) o `std::process::Command` escapa argumentos de `.cmd`/`.bat`, mas **recusa** `\r` e `\n` com `batch file arguments are invalid`. Não é excesso de zelo: `cmd.exe` não tem como receber uma quebra de linha num argumento. Todo prompt de Mission é multi-linha, então o lançamento headless desses providers falhava antes de começar.

### Solução

Um ponto único, `util::external_command(program, args)`, usado pelo supervisor:

| Programa | Como lança |
| --- | --- |
| `.exe` / binário nativo | Direto, argumentos como vetor. |
| Shim npm (`.cmd` gerado pelo cmd-shim) | Lê a receita do shim e lança **o alvo real**, sem `cmd.exe`: `%dp0%\node_modules\opencode-ai\bin\opencode.exe %*` vira o `.exe`; `"%_prog%" "%dp0%\...\codex.js" %*` vira `node` (o `node.exe` ao lado do shim ou o do PATH) + o script. |
| `.cmd` / `.bat` desconhecido | Escape do std. Com quebra de linha, erro explícito antes de lançar (nada de "achatar" o prompt). |
| Unix | Igual a antes. |

Não há `if windows && ends_with(".cmd")` espalhado: o supervisor chama `external_command` e só.

### Segurança de quoting

- Nunca `cmd /c "<programa> <args concatenados>"`. O prompt é dado não confiável.
- No caminho do shim não existe shell: `& | < > % ! "` e Unicode chegam literais ao processo.
- No `.bat` desconhecido vale o escape do std, que é o que corrigiu a CVE.

Testes (`util/test.rs::launch`): exe, cmd, bat, espaços no caminho, Unicode, multi-linha, aspas, metacaracteres e um teste de injeção real (`x & echo INJECTED> injected.txt` num `.bat` não cria o arquivo). Os testes com processo real usam um `echo.js` que devolve o `argv` recebido e comparam byte a byte.

### Resultado real (headless, pasta temporária)

Prompt mínimo ("responda só PONG") mais um bloco de dados hostil: `linha 1`/`linha 2`/linha vazia, `"aspas"`, `A&B`, `A|B`, `100%`, `café`, `C:\pasta com espaço\`.

| Provider | Lançado como | Resultado |
| --- | --- | --- |
| Codex (`codex.cmd`) | `node` + `codex.js` | OK: PONG, stream parseado (16 729 tokens in / 6 out). |
| OpenCode (`opencode.cmd`) com `opencode/big-pickle` | `opencode.exe` | OK: PONG, US$ 0. |
| OpenCode com o modelo padrão | `opencode.exe` | Erro preservado: "An active OpenCode Go subscription is required". Sem trocar de modelo. |

Também corrigido: um `item.completed` de tipo `error` do Codex (ex.: aviso de orçamento de skills) marcava a corrida como falha mesmo com exit 0 e resposta. Agora é aviso (`Tally.warning`), e só vira o motivo se a corrida realmente falhar.

Os testes com CLI real ficam `#[ignore]` (`runs/test.rs::lanzamiento_real`), com o modelo em `CC_E2E_<AGENTE>_MODEL`.

## 2. Detectado, headless, lançado

Três afirmações diferentes, que a UI e os docs não devem misturar:

| Nível | Significa | Onde se vê |
| --- | --- | --- |
| **CLI detectado** | O binário existe e responde (`installed`/`launchable` no roster). | `run_roster`, Ajustes. |
| **Headless implementado** | Existe um `HeadlessAgent` para o provider (`capabilities().headless`). Só esses podem ser lead ou worker. | `agents::adapter_for(id)`, `runs::ensure_headless`. |
| **Lançamento bem-sucedido** | O processo subiu nesta máquina, recebeu os argumentos e o parser viu o início e o resultado. | Teste real / E2E. Não é um flag. |

Não foi criada nenhuma capability nova para isso. A única adição ao contrato é `HeadlessAgent::enforces_read_only()`, necessária para a política do lead (seção 3).

## 3. Política do lead

O lead coordena; não modifica o workspace. A regra é **por `task.role == "lead"`**, nunca por provider. Tasks manuais e workers seguem como antes.

| Tool / ação | Lead | Worker |
| --- | --- | --- |
| Read (e Grep, Glob, LS, WebFetch, WebSearch) | permitido | permitido |
| Write | **negado** | pede aprovação (Claude Code) / conforme o provider |
| Edit | **negado** | pede aprovação (Claude Code) / conforme o provider |
| Bash | **negado** | pede aprovação (Claude Code) / rejeitado headless (OpenCode) |
| `run_plan` | permitido | não recebe |
| `task_add` | permitido | só abaixo da profundidade máxima |
| `fact_add` | permitido | permitido |

### Onde é imposta

1. **No broker** (`runs/broker.rs::resolve`), antes das regras da pasta: se a task é lead e a tool não está em `policy::lead_may_use`, a resposta é negar na hora, `decided_by = policy`. **Não entra na fila, não aparece para o usuário, não grava linha em `task_approvals`.** Nem um "Allow" nem uma regra lembrada mudam o papel do lead. A mensagem é:

   ```text
   Lead tasks cannot modify the workspace directly.
   Delegate implementation to a worker using run_plan/task_add.
   ```

2. **No lançamento**, com um flag genérico `LaunchCtx::read_only` que cada adapter traduz para o que sua CLI faz cumprir:

   | Provider | Tradução |
   | --- | --- |
   | Claude Code | `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell` (as tools nem chegam ao modelo; sem broker o `acceptEdits` as aprovaria). |
   | OpenCode | `permission.edit = "ask"`, `bash = "ask"`: headless, `ask` é rejeitado ("permission requested: edit … auto-rejecting", verificado). Não `deny`: `deny` tira as tools do pedido e o free tier do OpenCode responde `FreeTierError` (verificado no E2E). |
   | Codex | `--sandbox read-only`, com task MCP da ADE e orchestration headless. |
   | Antigravity nativo | Perfil MCP vinculado à Task, com política que nega escrita, comandos e atuação no navegador para o Lead. |
   | Gemini | `--approval-mode default` (edição e shell ficam sem aprovar = rejeitados headless). |
   | Kimi | Não dá: `--prompt` sempre aprova sozinho. `enforces_read_only() == false` e o supervisor recusa lançá-lo como lead, com erro claro. |

Não há parser de shell: sem classificação confiável de "comando só leitura", o lead fica sem Bash.

`policy::lead_may_use` permite as builtins de leitura e, do servidor `ade-ags`, as tools de orquestração (`agent_roster`, `run_plan`, `task_add`, `task_status`, `task_result`, `run_await`, `fact_add`, `facts_read`, `task_reroute`, `task_cancel`) e as de leitura. Todo o resto, inclusive MCP desconhecido, é negado.

### Prompt do lead

`LEAD_SYSTEM_PROMPT` diz que o lead nunca modifica o workspace (a ADE rejeita essas tools), que toda mudança vira task de worker, e que a integração é **uma task final de worker** que depende das outras. Saiu o "or do it yourself". Não existe papel persistente novo.

### Limites conhecidos

- A exposição das tools do navegador varia por adapter. O perfil nativo Antigravity nega atuação no navegador para o Lead; a política e a lista de tools permitidas da Task continuam sendo a referência.
- Codex recebe task MCP e suporta orchestration, headless, Lead e Worker. Gemini CLI continua distinto e sem essa integração de orquestração.
- Antigravity nativo suporta Lead e Worker usando a conta do sistema e modelos de `agy models`. Multi-account é experimental/incompleto, com `supports_accounts = false`; OAuth separado não equivale a isolamento do `agy`.

## 4. Aprovações dentro da Mission

Uma fonte só: a fila do broker, a mesma da Fleet.

```text
agente ─▶ ags mcp ─▶ broker::resolve ─▶ fila em memória ──cc-task-approvals──▶ useRunsStore.approvals
                                                                                  ├─▶ Fleet
                                                                                  └─▶ Missions (filtra pelas tasks do run ativo)
decisão (Fleet ou Missions) ─▶ run_decide_approval ─▶ broker ─▶ cc-task-approvals ─▶ as duas telas
```

- A tela de Missions lê `useRunsStore.approvals` (mantida por `useFleetEvents`, montado uma vez no shell). Não copia nada, não tem store paralelo.
- Cada task bloqueada mostra o `PermissionCard` da Fleet: agente, tool, resumo do pedido, Allow, Deny, e "Remember" só quando o broker sugere uma regra exata (`suggested_rule`), exatamente como na Fleet.
- Decidir numa tela remove o pedido nas duas, pelo mesmo evento.
- Nenhum status persistido novo. "Running · Aguardando sua aprovação" e o estado de cada agente (trabalhando, aguardando aprovação, aguardando dependências, na fila, concluída, falhou, parada) são derivados na view (`missionView.ts`).

Só providers que consultam o broker geram aprovações: hoje Claude Code. OpenCode, Codex e Gemini resolvem permissões pela própria configuração headless (seção 3 e `adapters.rs`), então com eles nada chega à fila.

## 5. Eventos

| Evento | Payload | Quando | Quem escuta |
| --- | --- | --- | --- |
| `cc-mission-changed` | `mission_id` | create, update, start (também se falhar), status final, cancel | Missions: relê a lista e, se for a aberta, o detalhe. Uma aberta em cache que não está na tela é descartada e relida ao abrir. |
| `cc-task-changed` | `task_id` | progresso de task | Fleet e Missions (como antes). |
| `cc-task-approvals` | fila inteira | a fila mudou | `useFleetEvents` → `useRunsStore` (como antes). |

O status final sai do mesmo lugar que o move: `runs::store::refresh_run` devolve a Mission quando o status dela mudou, e o `scheduler::tick` (por onde passa todo fim e toda parada de task) emite. `cancel_run` também avisa a Mission do run, para o caso de a frota cancelar um run que só tinha tasks pendentes. Sem polling, sem barramento novo.

## 6. Progresso

O lead não é trabalho distribuído, é quem distribui. `mission_list` devolve `workers_total`, `workers_done` (tasks do run ativo com `role` diferente de `lead`) e `lead_status` à parte.

| Situação | Mostra |
| --- | --- |
| Draft | nada |
| Lead rodando, zero workers | "Lead planejando" |
| Com workers | "X / Y workers concluídos" |
| Terminada | "Y / Y workers concluídos" (ou nada, se o lead terminou sem distribuir) |

O detalhe mostra o lead numa linha própria ("Lead · trabalhando") e conta os estados só dos workers. A Fleet continua mostrando todas as tasks.

## 7. E2E real (29/09/2026, Windows, build release)

Repo git descartável `%TEMP%\ade-runtime-e2e` (só `README.md` + commit inicial). Mission "Criar dois arquivos: backend.txt contendo "backend" e frontend.txt contendo "frontend" e validar que ambos existem", paralelismo 2, orçamento US$ 1, conduzida pela UI real via WebView2 com remote debugging. Backup do banco antes. Os tiers `trivial`/`standard` foram apontados para `opencode/big-pickle` (grátis) durante o teste e restaurados no fim.

| Tentativa | Lead | Resultado |
| --- | --- | --- |
| 1 | Claude Code `claude-code/spacexai/grok-build-0.1` | Gateway respondeu 503 nas 10 tentativas da CLI. Mission, run e lead `failed` com o erro na tela. US$ 0. Sem fallback. O processo recebeu `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell`. |
| 2 | OpenCode `opencode/big-pickle` | `FreeTierError` (403). Causa isolada fora da ADE: `permission: deny` tira as tools do pedido. Corrigido para `ask` (seção 3). |
| 3 | OpenCode `opencode/big-pickle` | **OK.** Detalhe abaixo. |

Tentativa 3:

- Draft criado, **zero processos** filhos da ADE antes do Start; `cc-mission-changed` no create.
- Start pela UI → um lead (`opencode.exe` lançado direto pelo launcher novo, com o servidor MCP da ADE).
- O lead usou só `agent_roster`, `read`, `run_plan`, `fact_add`, `run_await`, `task_result`. **Nenhuma tentativa de modificar o workspace.**
- `run_plan` criou 3 workers: `create-backend` e `create-frontend` independentes (rodaram em paralelo) e `verify-both` dependendo dos dois. Todos em OpenCode `opencode/big-pickle`, conta padrão.
- A UI mostrou "Lead · trabalhando" + "1 / 3 workers concluídos" durante, e "3 / 3" no fim.
- Workers: `write` concluído; `bash` rejeitado pelo OpenCode headless. **Nenhuma aprovação chegou à ADE**: OpenCode não consulta o broker.
- Mission `done`, 65 s do start ao fim (registro no banco), US$ 0. `backend.txt` = `backend`, `frontend.txt` = `frontend`, na raiz, sem commit (o lead escolheu `isolate: false` e registrou isso como fact).
- ADE fechada e reaberta → as três Missions deste E2E e as do v0 visíveis, com status, workers, resultado e fact.

Não demonstrado ao vivo: aprovações na tela de Missions. Exigem um worker Claude Code, e o gateway Claude desta máquina estava indisponível (503) durante todo o teste. O fluxo está coberto pelos testes de frontend (`missionApprovals.test.ts`) e pelo teste de contrato do backend.

## 8. Testes

- Backend: launcher (10), política do lead (Read/orquestração permitidos; Write/Edit/Bash negados; worker e manual iguais; pedido negado do lead fora da fila e do registro; tradução por adapter; Kimi recusado), contrato completo (Mission start → lead Write/Edit/Bash negados sem aprovação nem arquivo → `run_plan` real cria 2 workers), eventos (create/update via comando real com `mock_app`, status final/falha/cancel via `refresh_run`), progresso só de workers.
- Frontend: aguardando aprovação, Allow, Deny, a decisão tira o bloqueio, evento da fila atualiza a Mission, `cc-mission-changed` atualiza outra view, progresso sem lead, zero workers = "Lead planejando", terminada = workers concluídos.
- `mission_start` e `mission_cancel` precisam do `AppHandle` concreto (lançam e param agentes), então o evento deles foi verificado no E2E, não com `mock_app`.

## Estado consolidado da base ADE

Mission Engine e Mission Runtime estão concluídos nesta base, com retry de Mission failed criando outro Run e preservando o histórico. Roles/Squads, model discovery, reasoning effort, PT-BR e Handoff Structured v0 reutilizam o mesmo runtime. O launcher interativo Windows também resolve o alvo dos shims npm, evitando executar `.cmd` como binário nativo (erro 193). Custos continuam parciais conforme os dados fornecidos por cada provider.

Shared Memory v0 está **implementada e validada na PR #4 (`feat/shared-memory-v0`), aguardando merge**, com gates e E2E real concluídos em 01/10/2026: retry, MCP, Fact, handoff, proposta aprovada pelo usuário e persistência após restart. Commits e push realizados; PR #4 aberta, ainda não mergeada. Ver [SHARED_MEMORY.md](./SHARED_MEMORY.md).
