# Roles + Squads v0

**v0 concluído nesta base ADE.** Roles + Squads acrescenta roteamento funcional reutilizável ao Mission Runtime. Roles são built-in declarativas em código; provider, modelo e conta ficam na configuração de cada Squad.

## Conceitos

```text
Execution Role: lead | worker
Functional Role: backend | frontend | qa | reviewer | researcher | devops | integrator | generalist
```

**Execution Role ≠ Functional Role.** `Task.role` continua descrevendo a política de execução. O Lead Guardrail depende exclusivamente de `Task.role == "lead"`. `Task.functional_role` guarda a especialidade, quando existe, sem conceder permissões. Reviewer recebe instruções de revisão, mas não ganha enforcement read-only.

| Conceito | Significado | Persistência |
| --- | --- | --- |
| Role | O que deve ser feito: descrição e instruções de uma especialidade. | Catálogo built-in declarativo em `roles.rs`. |
| SquadMember | Quem executará aquela especialidade: provider, modelo, conta e preferências de roteamento. | `squad_members`. |
| Squad | Configuração reutilizável de Lead e membros por Role. | `squads` + `squad_members`. |
| Mission | Seleciona um Squad opcional no draft. | `missions.squad_id`, nullable. |
| Run | Congela nome e configuração de roteamento dos members no início. | `runs` + `run_squad_members`. |
| Task | Guarda o papel funcional e a resolução efetiva do worker. | `tasks.functional_role`, `agent_id`, `model`, `account_id`. |

O Lead do Squad é uma configuração separada. Ele continua sendo criado como `Task.role = "lead"`; não é um SquadMember nem uma Role funcional.

## Catálogo built-in

| ID | Role | Objetivo |
| --- | --- | --- |
| `backend` | Backend | Lógica server-side, APIs, acesso a dados e testes backend. |
| `frontend` | Frontend | Interfaces client-side, interações e testes frontend. |
| `qa` | QA / Tests | Cobertura de testes, verificação e relatos reproduzíveis de defeitos. |
| `reviewer` | Reviewer | Encontrar defeitos, regressões e testes ausentes; evitar reescrita sem pedido. |
| `researcher` | Researcher | Investigar código, APIs e restrições; reportar evidências e opções. |
| `devops` | DevOps | Build, CI, empacotamento, configuração operacional e tooling. |
| `integrator` | Integrator | Integrar branches de workers, resolver conflitos e validar o resultado conjunto. |
| `generalist` | Generalist | Cobrir trabalho que não cabe em uma especialidade configurada. |

Cada item tem `id` estável, `label`, `description` e `instructions`. Não contém provider, modelo ou conta. Roles customizadas, marketplace e edição do catálogo ficam fora do v0.

## Schema e compatibilidade

Schema v20 é aditivo e idempotente:

- `squads`: nome, descrição, provider/modelo/conta do Lead, auto account, complexidade e timestamps.
- `squad_members`: chave `(squad_id, role_id)`, provider, modelo, account ID, auto account, complexidade e `isolate_default`.
- `missions.squad_id`: nullable; Mission anterior continua usando o routing atual.
- `runs.squad_id` e `runs.squad_name`: referência e nome do Squad usado no histórico.
- `run_squad_members`: cópia da política funcional no início do Run para roles ainda não planejadas.
- `tasks.functional_role`: nullable; Task antiga continua válida e `Task.role` não é convertida.

Schema v21 acrescenta reasoning effort nullable a Missions, Tasks, Squads, members e snapshots. Effort é separado de model e complexity, validado conforme provider/modelo e aplicado por Task, sem alterar a configuração global do usuário. Os modos Provider default (`model = null`, `complexity = null`), Complexity (`model = null`, `complexity` definida) e Specific model (`model` definido, `complexity = null`) são mutuamente exclusivos.

Squad é mutável; Run é histórico. Alterar um Squad afeta somente novos Runs. Uma Task criada já guarda `functional_role`, provider, modelo e account ID resolvidos. O snapshot no Run é necessário para planejar Tasks futuras daquele mesmo Run sem consultar a configuração mutável.

Delete de Squad é permitido apenas sem referência por Mission ou Run. A exclusão não faz cascade em dados operacionais; referências históricas bloqueiam a operação.

## Modos de execução da Mission

| Modo | Configuração da Mission | Roteamento do Lead |
| --- | --- | --- |
| Automatic routing | Sem Squad ou provider fixo; mantém complexidade/tiers. | Routing existente. |
| Specific provider | Sem Squad; provider/model/account explícitos. | Configuração da Mission. |
| Squad | `squad_id` definido e campos manuais do Lead ausentes. | Lead do Squad. |

O backend rejeita campos manuais conflitantes quando `squad_id` está presente. Start verifica o Lead antes de criar o Run. Members de worker são opcionais: um member inválido não bloqueia Start se não for usado; o plano é rejeitado antes de criar Tasks se tentar usar aquele member.

## Planejamento e resolução

No Run com Squad, o Lead planeja pelo ID funcional:

```text
PlanTask.role = "backend"
    ↓
Run snapshot → member backend
    ↓
provider + account + model configurados
    ↓
Task(role=worker, functional_role=backend, agent_id, account_id, model)
```

`role` é aceito como alias JSON de `functional_role`. Cada Task do plano precisa usar uma Role configurada. Um Role ausente rejeita o DAG inteiro. O Lead não pode sobrescrever `agent`, `model` ou `account`; a ADE resolve a configuração do member. Sem Squad, o fluxo e o routing/tier existentes continuam válidos.

Provider, account e modelo não são substituídos silenciosamente. Provider desconhecido, ausente, não headless ou não instalado e account removida/incompatível aparecem como indisponíveis. A ADE só classifica um modelo como inválido quando o runtime tem informação confiável; modelos explícitos sem catálogo verificável ficam `unknown` e são validados pelo router ao planejar.

O contexto do Lead lista IDs e descrições das Roles do snapshot, sem provider/model/account. Workers recebem as instruções da Role no system context, separadas do prompt específico da Task. Quando há branches isoladas e o Squad oferece `integrator`, o Lead é orientado a delegar a integração a essa Role. O Lead continua sem permissão de escrita, edição, Bash mutável ou merge direto.

## Disponibilidade e contas

Codex suporta task MCP, orchestration e execução headless como Lead e Worker. Antigravity nativo suporta Lead e Worker e descobre modelos via `agy models`, usando uma conta do sistema. `supports_accounts = false`: OAuth experimental não disponibiliza execução simultânea isolada por conta.

A disponibilidade do Squad para Start acompanha o Lead. Members opcionais são avaliados quando o plano os usa. A UI mostra cada member, provider/modelo/conta e seu estado; uma conta removida continua persistida pelo ID e aparece como indisponível até o usuário editar o Squad.

SQLite guarda account IDs. Nome de conta é apresentação resolvida pelo roster atual. Tokens, secrets e environment resolvido não são armazenados no Squad.

## Validação de fechamento

A Mission E2E Squad concluiu em 114 segundos com Lead Claude Code / `claude-sonnet-5-5` e três workers Codex / `gpt-6-luna`: Backend, Frontend e QA / Tests. Backend e Frontend executaram em paralelo; QA dependeu dos dois e validou os arquivos. Run, resultados, assignments, effort, DAG, snapshot e custo permaneceram salvos após restart.

O custo salvo foi US$ 0,436865, correspondente ao valor reportado pelo Lead/execução disponível. Custos individuais dos workers Codex ainda não são contabilizados; ficam como dívida de observabilidade por provider.

Uma Mission failed pode ser reenviada com Tentar novamente, criando outro Run sem apagar o histórico anterior.

## Fora do v0

Roles customizadas, marketplace, permissões universais por Role, auto-scoring, troca automática de modelo, cost optimizer, Shared Memory, Map Mode, templates, cloud e colaboração.

Handoff Structured v0 foi concluído separadamente, com migration v22 e compatibilidade legacy; veja [HANDOFF_STRUCTURED.md](./HANDOFF_STRUCTURED.md).
