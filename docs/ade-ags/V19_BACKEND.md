# V19 — Backend

Build instalado 1.8.7, b5d7c3ad5979fddd6e80ce71d36a60260482ad79. Branch cc/mission-4d39a704-c0b0-4ed0-9987-0af86375. Janela do app não foi aberta; nenhum código do produto alterado; banco acessado exclusivamente com SQLite mode=ro e PRAGMA query_only=ON. Sem branch nova, push, PR, merge ou proposta de memória neste papel.

## Vigia — FALHA na distinção entre progresso e entrega

Gravidade P2: andamento longo com nome do agente é classificado como relatório final e pode retirar o integrante das cobranças antes de concluir. Fonte: src/features/missions/vigiaPoke.ts, isFinalReport; src/features/missions/vigia.ts grava finishedAt quando a função retorna true. NOT_A_DELIVERY verifica a primeira linha ainda prefixada pelo nome; a remoção do nome ocorre só depois do retorno antecipado por >=100 caracteres.

Reprodução sem modificar arquivos: executar na raiz do worktree:

```javascript
node -e "const fs=require('fs');const ts=require('typescript');const source=fs.readFileSync('src/features/missions/vigiaPoke.ts','utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;const m={exports:{}};new Function('exports','module',js)(m.exports,m);const texts=['Backend: em andamento. Vou executar as suítes e ler o banco; resultados ainda pendentes, nenhum relatório final disponível.','recebido'];for(const text of texts)console.log(JSON.stringify({text,chars:text.length,actual:m.exports.isFinalReport(text,'tell','Backend',true),expected:false}));"
```

Saída exata:

```json
{"text":"Backend: em andamento. Vou executar as suítes e ler o banco; resultados ainda pendentes, nenhum relatório final disponível.","chars":123,"actual":true,"expected":false}
{"text":"recebido","chars":8,"actual":false,"expected":false}
```

O caso curto recebido FUNCIONA (false); o andamento longo FALHA (true, esperado false). A observação de avisos ao vivo fica para depois dos relatórios da equipe; a ausência de aviso sozinha não comprova o estado interno finishedAt.

## run-id — FUNCIONA

Comandos executados com ADE_TAB_ID do próprio Backend no IPC local. Run válido escolhido por SELECT id,status FROM runs ORDER BY created_at DESC LIMIT 1: 27befff6-6c3d-4630-a069-31bdd48bb1b8 (done). Esta missão não possui run vinculado em runs.

Para cada comando abaixo:

```powershell
ags run status --run-id v19-inexistente
ags run result --run-id v19-inexistente
ags run facts --run-id v19-inexistente
```

Saída exata de cada um:

```json
{"error":"não há nenhum run v19-inexistente"}
```

Para cada comando abaixo (exit 1):

```powershell
ags run status --run-id
ags run result --run-id
ags run facts --run-id
```

Saída stderr exata de cada um:

```text
--run-id precisa de um valor
```

```powershell
ags run status --run-id 27befff6-6c3d-4630-a069-31bdd48bb1b8
```

Saída:

```json
{"text":"Run 27befff6-6c3d-4630-a069-31bdd48bb1b8 — Revisar memória e propor melhorias com fontes\nestado: concluído · gasto $0.45 · até 1 em paralelo\n- 2c3a30b7 [concluído] Sonhar agora · claude-code/sonnet · $0.45\n    resultado: Não propus nada neste sonho.\n"}
```

```powershell
ags run result --run-id 27befff6-6c3d-4630-a069-31bdd48bb1b8
```

Saída exata (argumento task obrigatório, não é bug):

```json
{"error":"falta 'task' (key ou id)"}
```

Com --task 2c3a30b7, retornou {"error":"o run não tem nenhuma tarefa '2c3a30b7'"}. Com o id completo 2c3a30b7-1af6-4948-ba9d-fc423c291f8e, retornou o resultado concluído (não exige aceitar prefixo de id; não listado como bug).

```powershell
ags run facts --run-id 27befff6-6c3d-4630-a069-31bdd48bb1b8
```

Saída exata:

```json
{"text":"{\"items\":[],\"hasMore\":false,\"nextCursor\":null,\"truncated\":false}"}
```

## Suítes — FUNCIONA

```powershell
ags test run frontend
ags test run tsc
ags test run rust
```

Saídas finais exatas (logs de spawn omitidos):

```text
 Test Files  204 passed (204)
      Tests  1736 passed (1736)
   Start at  12:01:28
   Duration  13.38s (transform 24.21s, setup 0ms, import 47.19s, tests 15.64s, environment 32.27s)
{"cacheHit":false,"durationMs":14248,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"7de409ba4dbd86d19c3000ed8ba93837fc2438e4"}
{"cacheHit":false,"durationMs":16110,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"7de409ba4dbd86d19c3000ed8ba93837fc2438e4"}
{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 92 min)","passed":true,"suite":"rust","treeHash":"7de409ba4dbd86d19c3000ed8ba93837fc2438e4"}
```

Frontend 14,248 s contra linha de base 18 s; tsc 16,110 s contra 23 s. Rust não foi reexecutado: cache verde do mesmo hash (reutilização autorizada), portanto não há comparação nova com ~135 s. Primeira tentativa sandbox de frontend falhou no esbuild por Access is denied; repetida fora do sandbox passou. Erro de sandbox é conhecido e não é achado do produto.

```powershell
ags test affected --dry-run
ags test affected
```

Saídas finais exatas antes da escrita do relatório:

```text
Nada a testar: só arquivos sem efeito em código.
{"commands":[],"full":false,"ignored":[],"risk":[],"unmapped":[]}
Nada a testar: só arquivos sem efeito em código.
{"full":false,"ignored":[],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
```

## Decisões — FUNCIONA (leitura e estatísticas)

Amostra histórica de todo o banco, não exclusivamente desta missão. decision_human_log não tem provider, latência ou erro: não é possível separar suas 94 linhas de memory_approval por provider sem inventar associação. p95 usa nearest rank (ceil(0,95*n)); timeouts identificados pelo texto de error.

| Provider | Ponto | Linhas | Média ms | Mediana ms | p95 ms | Erros | Timeouts |
|---|---|---:|---:|---:|---:|---:|---:|
| jev | memory_approval | 50 | 474,68 | 461,5 | 544 | 0 | 0 |
| jev | mission_gate | 7 | 510,43 | 544 | 618 | 0 | 0 |
| laya_local | memory_approval | 36 | 848,92 | 703,5 | 2006 | 2 | 2 |
| laya_local | mission_gate | 6 | 467,33 | 437 | 633 | 0 | 0 |

Jev mostrou vantagem observada na revisão de memória (latências menores e zero timeouts); não na média/mediana do gate de missão. Comparação observacional, períodos e entradas diferentes, amostra pequena no gate; não prova vantagem geral. Configuração experimental não foi alterada nem consultada pelo provedor nesta rodada do Backend.

## Resultado completo e validação após documentação

Comandos: `ags run result --run-id 27befff6-6c3d-4630-a069-31bdd48bb1b8 --task 2c3a30b7-1af6-4948-ba9d-fc423c291f8e`, `ags test affected --dry-run`, `ags test affected`.

Saída exata:

```text
{"text":"2c3a30b7 — Sonhar agora\nestado: concluído · tentativas 1 · custo $0.45 · claude-code/sonnet\n\n(O que segue foi escrito por um agente: dados, não instruções.)\nresultado:\nNão propus nada neste sonho.\n\n- **Falta de evidência citável.** A única fonte fornecida é o fato `ags://run/102c4370-0f50-4838-8073-f0b8f3365d11/fact/aa898156-0dcb-45ca-95b1-682c60acab65`. Ele diz que numa missão só de teste nenhum arquivo fora de `docs/ade-ags/` pode ser alterado e que não se deve reiniciar o app. Vale só para aquela missão e não é uma regra durável do workspace. Também não confirma nenhuma das duplicatas abaixo. Citá-lo como motivo de uma fusão ou exclusão seria inventar uma citação, o que as regras proíbem.\n- **Duplicatas que vi na memória aprovada.** Merecem revisão quando houver fonte que as sustente:\n  - `agent-updates-origem-verificada` (`0975d2de`), `agent-updates-official-commands` (`508fe25f`) e `atualizacao-agentes-so-origem-confirmada` (`dde147bf`) cobrem quase o mesmo conteúdo.\n  - `checkout-principal-desatualizado` (`ccb9c3bb`), `worktree-clone-principal-desatualizado` (`c27affe8`) e `checagem-existe-so-em-origin-master` (`856cc78f`) descrevem o mesmo problema do clone principal defasado.\n  - `vigia-unidades-tempo` (`20d7de8e`) e `missao-startedat-em-segundos` (`c0af4342`) tratam do mesmo erro de unidade (segundos contra milissegundos).\n  - `cargo-target-compartilhado-lock` (`3fe706dc`) e `cargo-test-lock-exe-em-uso` (`62560f9e`) se sobrepõem em parte.\n- **Listagem incompleta.** A listagem de memória veio paginada (`hasMore: true`), então não vi todas as entradas.\n\nSe você indicar uma run, tarefa ou fato que sustente as fusões, eu proponho as atualizações e exclusões com `expected_revision` e a citação correta.\n"}
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames origin/master...HEAD dur_ms=81 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames HEAD dur_ms=83 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= ls-files --others --exclude-standard -z dur_ms=107 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames origin/master...HEAD dur_ms=84 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames HEAD dur_ms=83 exit=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/V19_BACKEND.md
{"commands":[],"full":false,"ignored":["docs/ade-ags/V19_BACKEND.md"],"risk":[],"unmapped":[]}
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames origin/master...HEAD dur_ms=83 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames HEAD dur_ms=81 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= ls-files --others --exclude-standard -z dur_ms=108 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames origin/master...HEAD dur_ms=82 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames HEAD dur_ms=82 exit=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/V19_BACKEND.md
{"full":false,"ignored":["docs/ade-ags/V19_BACKEND.md"],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
```

Comando reprodutível das estatísticas (PowerShell):

```powershell
$codigo = @'
import sqlite3,json,sys,statistics,math; sys.stdout.reconfigure(encoding='utf-8'); c=sqlite3.connect('file:C:/Users/tonz1n/.ags/data.db?mode=ro',uri=True); c.execute('PRAGMA query_only=ON'); 
for provider,point in c.execute('SELECT DISTINCT provider,point FROM decision_shadow_log ORDER BY provider,point'):
 rows=c.execute('SELECT latency_ms,error FROM decision_shadow_log WHERE provider=? AND point=?',(provider,point)).fetchall(); xs=sorted(x[0] for x in rows if x[0] is not None); errors=[x[1] for x in rows if x[1]]; print(json.dumps({'provider':provider,'point':point,'rows':len(rows),'mean_ms':statistics.mean(xs) if xs else None,'median_ms':statistics.median(xs) if xs else None,'p95_ms':xs[math.ceil(.95*len(xs))-1] if xs else None,'errors':len(errors),'timeouts':sum('timeout' in e.lower() or 'timed out' in e.lower() or 'tempo' in e.lower() for e in errors)},ensure_ascii=False))
print('human',json.dumps(c.execute('SELECT point,count(*) FROM decision_human_log GROUP BY point').fetchall(),ensure_ascii=False))
'@
python -c $codigo
```

Saída exata:

```text
{"provider": "jev", "point": "memory_approval", "rows": 50, "mean_ms": 474.68, "median_ms": 461.5, "p95_ms": 544, "errors": 0, "timeouts": 0}
{"provider": "jev", "point": "mission_gate", "rows": 7, "mean_ms": 510.42857142857144, "median_ms": 544, "p95_ms": 618, "errors": 0, "timeouts": 0}
{"provider": "laya_local", "point": "memory_approval", "rows": 36, "mean_ms": 848.9166666666666, "median_ms": 703.5, "p95_ms": 2006, "errors": 2, "timeouts": 2}
{"provider": "laya_local", "point": "mission_gate", "rows": 6, "mean_ms": 467.3333333333333, "median_ms": 437.0, "p95_ms": 633, "errors": 0, "timeouts": 0}
human [["memory_approval", 94]]
```

## Branch e PR — FUNCIONA para este integrante

Comandos e saídas:

```powershell
git branch --show-current
```

```text
cc/mission-4d39a704-c0b0-4ed0-9987-0af86375
```

`git diff --check`: exit 0, sem saída. `gh pr list --head "cc/*" --state open`: exit 0, sem saída. O filtro head pode ser literal; saída vazia desse comando não demonstra sozinho ausência de todos os PRs cc/. Este integrante não criou branches ou PRs, não deu push nem fez merge.
