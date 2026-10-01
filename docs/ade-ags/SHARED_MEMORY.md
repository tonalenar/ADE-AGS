# Shared Memory v0

**Estado: implementação validada no WIP `feat/shared-memory-v0`.** Gates e E2E real concluídos em 01/10/2026; alterações ainda sem commit, push ou merge.

Shared Memory mantém contexto local e aprovado entre Runs. A implementação reutiliza SQLite, Mission Runtime e o servidor MCP `controlcode`; não usa serviço cloud nem inferência para consolidar conteúdo.

## Três tipos de informação

| Tipo | Escopo e duração | Escrita | Efeito em Runs |
| --- | --- | --- | --- |
| Workspace Memory | Workspace; persiste até uma proposta aprovada de edição ou exclusão | Revisões `proposed`, aprovadas pelo usuário | Entra no snapshot dos próximos Runs daquele Workspace |
| Mission Memory | Uma Mission; persiste independentemente de retry | Revisões `proposed`, aprovadas pelo usuário | Entra no snapshot dos próximos Runs daquela Mission |
| Run Fact | Um Run; append-only e colaborativo | Lead ou Worker do Run | Pode ser lido e compartilhado apenas dentro daquele Run |

`Run Fact ≠ Mission Memory ≠ Workspace Memory`. Promover um Fact é explícito e cria uma proposta com `source_fact_id`; isso não remove, reclassifica nem edita o Run Fact.

## Migration v24

`memory_entries` identifica owner, `scope` (`workspace` ou `mission`), key normalizada, kind, estado (`active` ou `deleted`), revisão ativa, prioridade e timestamps. Índices únicos separam as keys de Workspace e Mission. A constraint de scope exige `mission_id` apenas para Mission Memory.

`memory_revisions` é o histórico append-only de `create`, `update` e `delete`, com estado `proposed`, `approved` ou `rejected`, body, hash SHA-256 de kind/body, prioridade, ator, origem Run/Task/Fact, motivo, revisão esperada e timestamps. Um índice parcial permite uma única proposta pendente por entrada. Trigger impede alterar conteúdo ou origem e permite somente a decisão da proposta.

`run_memory_snapshot` guarda uma cópia autossuficiente de cada entrada selecionada: revisão, scope, key, kind, body, prioridade, hash, ordem e marca de truncamento. `run_memory_snapshot_meta` existe mesmo quando não há entradas. Triggers impedem atualizações posteriores do snapshot e de seus metadados e novas inserções após o selamento. IDs de origem das revisões são metadados imutáveis; apagar o Run de origem não apaga a memória aprovada nem a proveniência. Excluir um Run continua removendo seus dados pela relação existente com Runs.

## Revisões e concorrência

Uma entrada nova só fica ativa depois da aprovação de sua revisão `create`. Uma edição propõe outra revisão com `expected_revision`; uma proposta obsoleta é recusada na aprovação. `delete` aprovado grava uma revisão e transforma a entrada em tombstone. Rejeitar uma revisão preserva a revisão atualmente ativa. Repetição idêntica para owner/scope/key e hash de kind/body é idempotente; conteúdo diferente exige uma nova proposta. Não existe merge semântico por LLM.

## Snapshot no início do Run

A primitiva `runs::store::create_run_with_memory_snapshot` cria o Run e seu snapshot em um savepoint, que participa da transação de criação do Lead/Task. `create_run` e `create_run_with` delegam para ela: criação manual, plano de orchestration, Start de Mission e retry usam a mesma seleção. Falhas revertem tanto Run quanto snapshot. A ordem determinística é:

1. prioridade descendente;
2. Mission antes de Workspace em empate;
3. key em ordem binária;
4. entry ID.

O limite automático é 16 entradas e 16 KiB do bloco automático completo, incluindo JSON escapado e delimitação. Corpos são truncados apenas em fronteiras UTF-8; os metadados contam entradas omitidas e truncadas. Snapshot vazio é uma linha de metadados com zero entradas. Retry cria outro Run e outro snapshot. Edição posterior de memória, Mission ou Squad não reescreve o histórico do Run anterior.

Lead e workers recebem o snapshot no campo de prompt/contexto, nunca no system prompt. O bloco usa JSON delimitado e o identifica como `UNTRUSTED DATA`. O snapshot é dado de projeto e não muda role, functional role, provider, model, account, effort, tools, permissions, Lead Guardrail nem Squad routing. Memória proposta durante um Run só pode entrar automaticamente em um Run futuro depois de aprovação.

## MCP, ownership e aprovação

O servidor MCP existente oferece `memory_list`, `memory_get`, `memory_propose`, `memory_update`, `memory_delete` e `memory_promote_fact`. A Task que iniciou a chamada determina o encadeamento `Task → Run → Mission → Workspace`; parâmetros enviados pelo modelo nunca escolhem IDs de owner ou ator. Apenas Tasks com papel Lead ou Worker usam essas ferramentas.

Leads e workers só propõem. Não existe tool MCP para aprovar ou rejeitar. A UI local mostra a proposta e oferece aprovação ou rejeição explícita ao usuário. Leituras e respostas MCP respeitam 32 entradas e 32 KiB. Bodies cujo escape JSON exceda o limite combinado são mostrados como previews, com `bodyTruncated` e `pendingBodyTruncated`. `memory_get` aceita `revision` para ler o body integral de uma revisão autorizada dentro do limite; a UI usa o detalhe completo e o histórico pelo IPC local. Memória é renderizada como texto, nunca como HTML executável.

## Run Facts

`facts_read` preserva chamadas sem argumentos e retorna páginas newest-first com `hasMore`, `nextCursor` e `truncated`; itens exibem um preview limitado e número de bytes. `fact_read` fornece o corpo integral em blocos UTF-8, cada um limitado a 4 KiB para manter as respostas MCP abaixo de 32 KiB mesmo com caracteres que precisam de escape. O cursor é o ID do último Fact da página; o backend resolve `(created_at, rowid)` dentro do próprio Run para continuar sem offset. Inserções de Facts novos não deslocam a próxima página. Cursors de outro Run são rejeitados. Uma janela menor que o próximo caractere UTF-8 é recusada para evitar loops sem avanço.

## Limites

| Campo ou quota | Limite |
| --- | ---: |
| Key normalizada | 128 bytes UTF-8 |
| Body de revisão | 4 KiB |
| Motivo | 512 bytes UTF-8 |
| Propostas pendentes | 32 por owner |
| Entradas ativas | 128 por Mission; 256 por Workspace |
| Owner quota | 8 MiB somando revisões e keys |
| Resposta MCP | 32 itens e 32 KiB |
| Snapshot automático | 16 entradas e 16 KiB agregados |

Trimming e validação contam bytes UTF-8, não unidades UTF-16 nem caracteres visuais. Keys e bodies usam Unicode NFC e trim externo; bodies também normalizam CRLF/CR para LF, sem colapsar whitespace interno. Updates idênticos retornam a revisão aprovada existente; propostas pendentes idênticas retornam a proposta existente.

## Interface

A tela de Missions apresenta abas de Memória do Workspace, Memória da Mission, Run Facts e Snapshot usado neste Run. A menor integração é o painel existente de Missions; o Workspace também está disponível sem uma Mission selecionada. Mostra key, tipo, body, prioridade, estado, revisão, origem, autor e data. O usuário pode aprovar ou rejeitar propostas, propor edição/exclusão, abrir o histórico e propor a promoção de um Run Fact. Conteúdo de memória é exibido em elementos de texto pré-formatado; nenhum body é interpretado como markup.

As views são atualizadas pelos eventos Tauri `cc-memory-changed` e `cc-run-facts`, sem polling. Propostas, decisões e promoções emitem o evento após liberar o mutex do banco.

## Cobertura

Os testes cobrem upgrades v19/v20/v21/v22/v23→v24 e inicialização limpa, isolamento de owner, ciclo de proposta/aprovação/rejeição, revisão esperada, tombstones, deduplicação e quotas, limites UTF-8, snapshot vazio/ordenado/imutável, retry e persistência, promoção explícita de Fact, paginação e leitura em blocos, autorização por Task e conteúdo malicioso tratado como dado. Testes DOM cobrem listas, decisões, propostas de edição/delete, histórico, snapshot, promoção, PT-BR, eventos e renderização de conteúdo malicioso.

## Fechamento e E2E real — 01/10/2026

Gates finais confirmados após as correções da revisão: TypeScript exit code 0; frontend com 580 testes em 70 arquivos, zero falhas; Rust com 726 testes aprovados, zero falhas e 9 ignorados; Clippy exit code 0 com warnings não bloqueantes; build Windows do aplicativo e da CLI exit code 0; `git diff --check` sem erros. Testes focados: memória 48, banco/migrations 38, handoff 17, IPC 42 e frontend de memória 13, todos aprovados. As contagens focadas são subconjuntos das suítes completas.

Findings P2 corrigidos: DDL da v24 e `user_version` agora compartilham savepoint/rollback, com regressão de falha intermediária preservando dados e versão anterior; `memory_get` não rejeita bodies válidos por overhead combinado do JSON, oferece previews explícitos e leitura integral por revisão. Upgrades v19/v20/v21/v22/v23→v24, reaplicação v24 e os três testes históricos de migration passaram. Os blocos Durable Memory Snapshot, Run Facts e Dependency Handoffs identificam os dados não confiáveis explicitamente; testes confirmam isolamento de owner e preservação do routing com conteúdo malicioso.

O primeiro E2E revelou uma CLI empacotada desatualizada, sem as ferramentas de memória, e um schema Codex incompatível. `app:build` agora compila e prepara a CLI junto com o aplicativo. As duas cópias da CLI tiveram hashes iguais e expuseram as seis ferramentas de memória. Schemas Codex incompatíveis são rejeitados depois do roteamento, antes da criação de Tasks, com uma segunda guarda antes do lançamento. A chamada real de `run.plan` com schema inválido foi recusada e manteve a contagem de Tasks em quatro.

O novo E2E usou uma cópia sintética do banco, projeto descartável e inference real com Lead e um worker Codex, sem alterar arquivos do projeto:

1. Aprovação pela UI da revisão 2 de `e2e-mission-marker`, alterando apenas a prioridade de 0 para 5.
2. Retry pela UI criou o Run `da06a469-6a74-42ca-b770-f9d839c1a6e1`, com snapshot da revisão 2/prioridade 5. O Run anterior `1cdbb16a-e8bb-480f-a037-96be96f4b493` conservou a revisão 1/prioridade 0 e seu estado de falha.
3. Lead consultou memória de Workspace e Mission pelo MCP. O worker `32918ba5-e693-4c82-ac1e-1eecb6a9f973` publicou o finding `b5aaa669-5e4c-461c-bb37-cf2c5ba81a5e`, com body `E2E_VERDE_20261001 confirmado`, e registrou handoff estruturado v1.
4. Lead leu os Facts e propôs `e2e-agent-result`, deixando a revisão pendente. Mission, Lead e worker terminaram em `done`, sem erro de Task. Antes do worker, duas chamadas de planejamento foram recusadas sem criar Tasks: uma seleção de complexity sem modelo Codex configurado e uma combinação incompatível de modelo específico com complexity. O Lead corrigiu os argumentos e a chamada seguinte criou o worker.
5. O usuário aprovou a proposta pela UI e fechou/reabriu a ADE. A consulta posterior confirmou revisão 1 aprovada, Fact, handoff e snapshots persistidos. A aprovação não inseriu a nova memória retroativamente no snapshot do Run concluído.
6. A comparação integral dos registros anteriores de Runs, Tasks, Facts e entradas de snapshot não encontrou alterações. O banco sintético e os logs foram preservados fora do repositório; a ADE foi fechada e o banco original restaurado com SHA-256 idêntico ao backup.

Evidências locais: `%TEMP%\ade-memory-e2e-final-20261001-194426\after-restart-evidence.json`, `historical-before.json`, `completed-after-restart.db` e `completed-run-logs\`. A revisão final cruzou novamente banco e logs, confirmando zero alterações nos registros históricos comparados. O E2E foi executado antes das correções finais de migration/reader; essas correções e os ajustes de delimitação foram validados pelos testes e pela build, sem nova inference. A edição de memória demonstrada ao vivo foi apenas de prioridade; edição de body, delete, concorrência, outros providers e os demais contratos listados na cobertura não são alegados como E2E e dependem dos testes automatizados aplicáveis.
