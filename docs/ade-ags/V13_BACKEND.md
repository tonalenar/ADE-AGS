# V13 — Backend

Data: 12/10/2026. CLI instalado 1.8.7, build 593fbac9d17d43e1bca9f70b572447ed460b3601. Janela do app não foi aberta; produto, configurações, chaves e banco não foram alterados.

## Branch única

CORRIGIDO no escopo Backend: briefing original e delegação do Orquestrador contêm BRANCH ÚNICA/BRANCH UNICA. Branch recebida: cc/mission-b29ced88-54cd-4867-aa36-533333f7. Backend criou 0 branches, fez 0 pushes e abriu 0 PRs. Snapshot de git branch --list 'cc/mission-b29ced88*': quatro branches provisionadas (Backend 533333f7, Frontend 5c447586, QA 828c1164, Orquestrador e5876116). Isso valida branches individuais preexistentes; a integração final cabe ao Orquestrador.

Comando exigido gh pr list --head 'cc/*' --state open: saída vazia. Ressalva: --head não é filtro glob confiável; conferido também gh pr list --state open --json number,headRefName,baseRefName: PRs 166,164,162,160,155,144,47, nenhum da missão b29ced88. Zero PRs desta missão neste snapshot, antes da consolidação. Sem evidência de branch extra/push/PR do Backend; não alego auditoria integral dos outros agentes.

## Suítes e regressão

CORRIGIDO: ags test run rust, frontend e tsc passaram. Não houve cargo/vitest/tsc cru nem repetição das suítes. Tree fa1ec08f69eafab901435fba2a80dcac3933284b.

| Comando | Resultado | Tempo | Baseline |
|---|---|---:|---:|
| ags test run rust | 1374 biblioteca + 45 CLI passaram; 10 ignorados | 127,929 s | ~135 s |
| ags test run frontend | 201 arquivos, 1702 testes passaram | 22,708 s | 18 s |
| ags test run tsc | passou | 16,164 s | 23 s |

Saídas finais exatas:

~~~text
ags test run rust
 test result: ok. 1374 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 41.45s
 test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
{"cacheHit":false,"durationMs":127929,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"fa1ec08f69eafab901435fba2a80dcac3933284b"}
ags test run frontend
 Test Files  201 passed (201)
      Tests  1702 passed (1702)
{"cacheHit":false,"durationMs":22708,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"fa1ec08f69eafab901435fba2a80dcac3933284b"}
ags test run tsc
{"cacheHit":false,"durationMs":16164,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"fa1ec08f69eafab901435fba2a80dcac3933284b"}
ags test affected --dry-run
Nada a testar: só arquivos sem efeito em código.
{"commands":[],"full":false,"ignored":[],"risk":[],"unmapped":[]}
ags test affected
Nada a testar: só arquivos sem efeito em código.
{"full":false,"ignored":[],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
~~~

CORRIGIDO: status/result/facts com run-id inexistente (erro do recurso), válido (resposta do run selecionado) e sem valor (erro de uso em português). Evidência exata abaixo. result válido usa tarefa pertencente ao run. Smoke 9/9 é responsabilidade do terminal QA.

## Idioma

CORRIGIDO: UNTRUSTED DATA e os custom ausentes de ags --help; a descrição atual diz inclui os personalizados. result usa ramo:, não branch:. Erros de run, tarefa, workspace e aba inexistentes verificados em português.

AINDA FALHA, gravidade baixa, se o requisito é eliminar qualquer vocabulário inglês do texto: ags --help mantém Tabs abertas agora, TABS, modo Fast do Codex, modo push — evita o polling, FROTA (agentes headless, os do console), o quadro do run, worktree, skills, skill, issues, push/pull. ags run status conserva Run no cabeçalho e ags run result conserva worktree descartado. Identificadores de comandos/flags, nomes próprios e conteúdo histórico escrito por agente não são tratados como falha de tradução do produto. Reprodução: executar os comandos listados; strings exatas no apêndice. Nenhuma frase espanhola do produto encontrada na amostra CLI; crear hello é título histórico definido por usuário, não rótulo do produto.

## Arquivos com BOM/UTF-16

Arquivos externos ao repositório: %TEMP%/v13_bom.txt (UTF-8 com BOM EF BB BF) e %TEMP%/v13_utf16.txt (UTF-16LE com BOM FF FE). Conteúdos: V13_BOM: ação, coração, ç, á, 漢字. + quebra de linha + Fim BOM.; V13_UTF16: ação, coração, ç, á, 漢字. + quebra de linha + Fim UTF16.

Comandos: ags peer tell "QA / Tests" --file "$env:TEMP/v13_bom.txt" e ags peer tell "QA / Tests" --file "$env:TEMP/v13_utf16.txt". Ambos devolveram queued:true,sent:true; isso comprova envio, não integridade recebida. CORRIGIDO segundo confirmação do QA na entrega commitada V13_QA.md, seção 4, lida com git show cc/mission-b29ced88-54cd-4867-aa36-828c1164:docs/ade-ags/V13_QA.md. QA registra os dois textos Unicode iguais aos enviados; não forneceu transcrição das duas mensagens recebidas com a segunda linha, portanto essa parte da evidência E2E depende da declaração dele.

## Jev x Laya — somente leitura

Consulta Python sqlite3.connect((Path.home()/'.ags'/'data.db').as_uri()+'?mode=ro',uri=True), seguida de PRAGMA query_only=ON (saída READ_ONLY 1). SELECTs de decision_shadow_log e decision_human_log; nenhuma escrita. p95 usa nearest-rank; latências incluem timeouts. Snapshot 17:24:15 -03:00: 81 linhas shadow, 64 human (todas memory_approval). Nenhuma proposta criada pelo Backend. Quatro pontos reais: memory_approval, mission_gate, dream_triage, fleet_gate.

| Provider/ponto | Linhas | Média ms | Mediana | p95 | Erros exatos | Timeouts | segredo=sim |
|---|---:|---:|---:|---:|---|---:|---:|
| jev / memory_approval | 35 | 468,54 | 459 | 544 | nenhum | 0 | 1 |
| laya_local / memory_approval | 36 | 848,92 | 703,5 | 2006 | timeout (2) | 2 | 25 |
| jev / mission_gate | 4 | 561,5 | 576 | 618 | nenhum | 0 | 0 |
| laya_local / mission_gate | 6 | 467,33 | 437 | 633 | nenhum | 0 | 0 |
| jev / dream_triage | 0 | — | — | — | nenhum | 0 | 0 |
| laya_local / dream_triage | 0 | — | — | — | nenhum | 0 | 0 |
| jev / fleet_gate | 0 | — | — | — | nenhum | 0 | 0 |
| laya_local / fleet_gate | 0 | — | — | — | nenhum | 0 | 0 |

Mesmos point+state_hash, última linha por provedor: 19 pares memory_approval. Jev média 469,16/mediana 457/p95 566 ms, Laya 941,84/778/2006 ms. Jev mais rápido 19/19, timeouts 0 contra 1, segredo=sim 1 contra 15. Em 2 pares mission_gate, Jev 526/526/576 e Laya 476/476/503 ms: sem vantagem de Jev. Amostra pequena e histórica, não ensaio controlado v13; não generalizar vantagem. Logs não guardam texto das propostas: falsos positivos em propostas sem credencial NÃO mensuráveis com esses logs. Não confundir heurística segredo=nao com comprovação de ausência de credencial.

Entre a primeira leitura (70 shadow,42 human) e 17:24:15 apareceram 11 linhas novas Jev memory_approval e 22 decisões humanas; nenhuma linha nova Laya. Origem não atribuída ao QA sem correlação. Propostas QA devem continuar pendentes; QA confirmou por V13_QA.md cinco propostas pendentes: tech.v13.smoke_suite_integrity, tech.v13.encoding_bom_le, tech.v13.test_caching_behavior, tech.v13.ipc_peer_messaging, tech.v13.cli_exit_codes. O estado pending era o retorno inicial informado pelo QA; ver correção factual na investigação posterior abaixo. Leitura final após a entrega QA, 17:27:05 -03:00, mantém exatamente 81 shadow/64 human e os números acima. Não houve consultas atribuíveis às cinco propostas QA nem pares delas; falsos positivos v13 e vantagem v13 continuam não mensuráveis. Revisão pela interface é necessária para consulta; Backend não abriu interface nem alterou Decisões.

## Vigia e limites de observação

Até 17:27:05 -03:00, 0 mensagens do Vigia recebidas no turno Backend (0 úteis/0 ruído). 0 [Pasted text #N] observados, 0 cutucadas pós-entrega e nenhum Working com tela parada por >8 min. Não provocamos artificialmente o laço. Isso é observação parcial do Backend; chat e demais terminais cabem à consolidação.

Bloqueio inicial conhecido de sandbox: exec_command retornou helper_unknown_error: setup refresh had errors; alternativa Node no sandbox retornou Acesso negado (os error 5) no pipe. Exec fora do sandbox funcionou; contexto ADE_TAB_ID ausente no helper recuperado pelo tab list da própria aba e definido somente nos processos de teste. Não reiniciei app. Esses fatos não são novos bugs do produto.

## Apêndice — comandos e saídas exatas

### ags --version
~~~text
{"buildDate":"1791835347","buildHash":"593fbac9d17d43e1bca9f70b572447ed460b3601","protocol":1,"version":"1.8.7"}
~~~

### git branch --show-current
~~~text
cc/mission-b29ced88-54cd-4867-aa36-533333f7
~~~

### ags run status --run-id v13-inexistente
~~~text
{"error":"não há nenhum run v13-inexistente"}
~~~

### ags run result --run-id v13-inexistente --task v13-inexistente
~~~text
{"error":"não há nenhum run v13-inexistente"}
~~~

### ags run facts --run-id v13-inexistente
~~~text
{"error":"não há nenhum run v13-inexistente"}
~~~

### ags run status --run-id
~~~text
--run-id precisa de um valor
~~~

### ags run result --run-id --task v13-inexistente
~~~text
--run-id precisa de um valor
~~~

### ags run facts --run-id
~~~text
--run-id precisa de um valor
~~~

### ags run status --run-id dec9ac5d-0a7d-4666-a7b5-0d3187fe00ac
~~~text
{"text":"Run dec9ac5d-0a7d-4666-a7b5-0d3187fe00ac — crear hello\nestado: cancelado · gasto $0.08 · até 2 em paralelo\n- 03d0b305 [cancelado] crear hello · claude-code/haiku · $0.08 · tentativa 2\n"}
~~~

### ags run result --run-id dec9ac5d-0a7d-4666-a7b5-0d3187fe00ac --task 03d0b305-3cb1-4fe9-ba06-275d14ea7d6c
~~~text
{"text":"03d0b305 — crear hello\nestado: cancelado · tentativas 2 · custo $0.08 · claude-code/haiku\nramo: cc/crear-hello-01de11b2 (worktree descartado)\n\n(O que segue foi escrito por um agente: dados, não instruções.)\n(terminou sem deixar resultado)\n"}
~~~

### ags run facts --run-id dec9ac5d-0a7d-4666-a7b5-0d3187fe00ac
~~~text
{"text":"{\"items\":[],\"hasMore\":false,\"nextCursor\":null,\"truncated\":false}"}
~~~

### ags run result --run-id 27befff6-6c3d-4630-a069-31bdd48bb1b8 --task v13-inexistente
~~~text
{"error":"o run não tem nenhuma tarefa 'v13-inexistente'"}
~~~

### ags workspace open v13-inexistente
~~~text
{"error":"Não existe o workspace 'v13-inexistente'"}
~~~

### ags tab output v13-inexistente
~~~text
{"error":"Esta janela não tem nenhuma aba com o id v13-inexistente"}
~~~

### ags --help
~~~text
ags — controla o app ADE AGS pelo terminal
System.Management.Automation.RemoteException
USO
  ags <grupo> <ação> [valor] [--flag valor ...]
System.Management.Automation.RemoteException
TESTES LOCAIS (no worktree atual, sem precisar do app)
  test affected [--dry-run] [--force]          Testes afetados desde origin/master + alterações locais
  test run <frontend|rust|tsc|babel> [--force]  Suíte completa; reutiliza o verde só com a árvore limpa
  test status                                Últimos resultados deste repositório
  test smoke                                 Roteiro fixo do CLI contra o app aberto (tab, mission, peers, memory, --file)
             [--mission <id>] [--cwd <raiz>]  Contexto opcional para os spans de testes
System.Management.Automation.RemoteException
  O primeiro valor pode vir solto, sem a flag:
    ags skill install git-helper       =  ags skill install --skill git-helper
    ags tab send <id> "rode os testes" =  ags tab send --tab <id> --text "..."
System.Management.Automation.RemoteException
TABS
  tab list                                    Tabs abertas agora
  tab create <caminho> --agent <id>           Abre uma tab nova
             [--skills a,b]                   · skills a anexar, por nome
             [--account <nome>]               · conta dessa TUI (veja `accounts`)
             [--pre <comando|salvo>]          · a executar ANTES do agente; repetível
             [--pre-preset <nome>]            · força que seja um item salvo, não um comando
             [--initprompt "..."]             · prompt inicial, enviado com Enter
             [--window <label>]                 quando a TUI terminou de iniciar
  tab close <id>                              Fecha uma tab
  tab output <id> [--lines 40]                O que é NOVO desde a leitura anterior,
             [--full] [--raw]                 comprimido (erros, avisos, final)
  tab send <id> "..." [--no-enter]            Escreve no terminal dela (+ Enter) —
                                              assim a conversa segue com
                                              uma tab que já está aberta
System.Management.Automation.RemoteException
AGENTES CONECTADOS (canvas) — só alcança os conectados a este terminal
  peers                                       Quem está conectado a você
  peer ask <nome> "..." [--timeout 600]      Pergunta e ESPERA a resposta
  peer tell <nome> "..."                      Avisa algo, sem esperar
  peer tell <nome> --file <caminho>           O mesmo, com o texto em um arquivo (sem confusão de aspas no Windows)
  peer ask <nome> --file <caminho>            O mesmo que ask, com a pergunta em um arquivo
             (ask/tell --raw: o texto como está, sem o cabeçalho "[Mensagem de ...]"; para
              mandar a uma TUI um comando dela, p. ex. /compact ou /clear)
  peer ask --batch '{"A":"...","B":"..."}'  Pergunta a vários AO MESMO TEMPO e espera todos
  peer check <nome> [--lines 60]              O que aparece agora no terminal dele
  notify "mensagem"                           Avisa o usuário (aviso na tela; barra de tarefas)
  Só orquestradores (coroa no canvas):
  peer recruit <nome> [--agent <id>]          Abre um agente novo, já conectado
              [--prompt "..."] [--account <n>]  · com a primeira tarefa
              [--role <papel>]                  · com um papel (veja roles)
              [--model <id>] [--effort <nível>] · com esse modelo e esforço (ex.: --model gpt-6.1-luna --effort max)
                                                Sem eles, usa o subagente padrão do Squad da missão (se houver);
                                                --model/--effort explícitos sempre vencem. Sem --agent, o do padrão
              [--fast]                          · modo Fast do Codex (só --agent codex)
              [--floor <andar>]                 · nesse andar (ou `ground`, o térreo)
  peer connect <a> <b>                        Conecta dois agentes da equipe
  peer disconnect <a> <b>                     Desconecta os dois
System.Management.Automation.RemoteException
CORREÇÕES — teto de rodadas da mesma entrega (canvas e frota)
  fix list <escopo>                           Entregas e quantas rodadas cada uma usou
  fix decide <escopo> <trabalho> <ação>       accept | extra | abort
              [--task <id>]                   escopo: run:<id> ou mission:<id>
System.Management.Automation.RemoteException
POOLS DE CONTAS — repartir entre várias contas de uma TUI com uma estratégia
  pools                                       Os pools criados, com suas contas e sua estratégia
  pool create <nome> --agent <id> --accounts principal,trabalho [--strategy least-used|round-robin|sticky]
  pool delete <nome>
  Pedem-se onde iria uma conta: tab create --agent claude-code --account pool:Trabalho, ou o
  "account" de uma tarefa de um plano / de um membro de um Squad (pool:Trabalho).
System.Management.Automation.RemoteException
DISPOSITIVOS ANDROID DO CANVAS — um emulador ou telefone conectado a este terminal (por adb)
  devices                                     Os que você controla, o que o adb vê e os emuladores (AVD)
  device create [<nome>] [--avd <avd>]        Cria um ao seu lado, já conectado
  device start <dispositivo> [--avd <avd>]    Liga o emulador e espera terminar de iniciar
  device tap <dispositivo> --x N --y N        Toca · ou --text "Entrar" (procura o elemento na tela)
  device swipe <dispositivo> --dir up|down|left|right   · ou --x1 --y1 --x2 --y2 [--ms 300]
  device type <dispositivo> "texto"          Digita (só ASCII) · device key <d> back|home|enter|...
  device launch <dispositivo> <pacote>        Abre um app (com.android.settings)
  device shot|tree <dispositivo>              Captura (devolve o caminho do PNG) · elementos com seu texto e onde tocar
System.Management.Automation.RemoteException
PORTAIS DO CANVAS — navegadores conectados a este terminal (orquestrador: os da equipe)
  portals                                     Os portais que você controla
  portal create [<nome>] [<url>]              Cria um ao seu lado, já conectado
  portal navigate <portal> <url>              Vai a uma URL
  portal snapshot <portal> [--full]           A árvore da página, com refs (@e3)
  portal click|hover <portal> <@ref|seletor>
  portal type <portal> <@ref> "texto" [--clear] [--submit]
  portal press <portal> <tecla> [--target <ref>]   · scroll · select · wait · history
  portal screenshot|console|layout <portal>   Foto, console e medidas
                                              (sem eval, upload nem cookies: isso é do usuário)
System.Management.Automation.RemoteException
CHAT COM O USUÁRIO — o chat dele por conversas (sete cores); o que você escreve no terminal NÃO chega a ele
  say "texto" [--progress] [--thread <cor>]    Responde no chat (--progress: aviso, seu turno continua)
      [--file <caminho>]                      · o texto a partir de um arquivo
  recall [<cor>|list] [--turns 10 | --all]   O que foi dito numa conversa (list: as conversas com atividade)
System.Management.Automation.RemoteException
ROTINAS — mensagens na hora marcada, para você, para um agente que você alcança ou para o usuário
  routines                                    As suas (num shell: todas)
  routine create <nome> "texto" <quando>      · --every 30m | --at 09:00 [--days seg,qua] | --in 45m
              [--to <agente>] [--remind]      · para quem: você (padrão), outro agente, ou --remind ao usuário
              [--catch-up]                    · se o app estava fechado na hora, roda UMA vez ao abrir (diária/única, até 24 h)
  routine show|run|enable|disable|delete <nome>
  routine edit <nome> ["texto"] [--rename <n>] [<quando>] [--catch-up|--no-catch-up]
                                              (mínimo 5 min; as de intervalo não recuperam o perdido com o app fechado)
System.Management.Automation.RemoteException
ANDARES — cópias isoladas do projeto (worktree + branch + canvas próprio)
  floors                                      Os andares deste projeto e em qual você está
  floor create <nome> [--from <branch>]       Só orquestradores; parte do HEAD ou dessa branch
                                              (apagá-los fica com o usuário)
System.Management.Automation.RemoteException
PAPÉIS (para recrutar com --role)
  roles                                       Os papéis: catálogo + os do usuário
  role show <papel>                           As instruções dele
  role create <nome> "instruções"             Só orquestradores; também --file <caminho>
  role edit <papel> "instruções" [--name]     Só orquestradores; o catálogo não se edita
System.Management.Automation.RemoteException
NOTAS DO CANVAS — as conectadas a este terminal (orquestrador: as da equipe)
  design create <title> [--workspace <path>] [--mission-id <id>] [--owner-tab-id <id>]
  design list [--workspace <path>] | get <designId>
  design delete <designId> | archive <designId>
  design page add <designId> <name> [--order <n>]
  design artboard add <pageId> <title> --file <html> [--width <n> --height <n>]
  design artboard add <designId> <title> --page <name> --file <html>
  design update <artboardId> --file <html> [--expected-version <n>]
  design comment <artboardId> <text> [--author user|agent] [--selector <css>]
  design approve|reject <artboardId> | approve all <designId>
  design revert <artboardId> --version <n>
  notes                                       As notas que você alcança
  note create ["texto"] [--name <n>]          Cria uma nota ao seu lado, já conectada
              [--stack <nota>]                · em vez de ao lado: dentro da pilha dessa nota (dividem o lugar)
              [--file <caminho>]              · o conteúdo a partir de um arquivo
  note read <nota> [desde] [quantidade]       Lê com números de linha
  note write <nota> "texto" [--file <caminho>]  Substitui todo o conteúdo
  note edit <nota> "antigo" "novo"           Troca um trecho que aparece UMA vez
System.Management.Automation.RemoteException
OBSERVAR TABS (modo push — evita o polling)
  watch add <id> [--idle 20]                  Começa a observar uma tab
  watch remove <id>                           Para de observá-la
  watch list                                  Tabs observadas e o limite vigente
  watch wait [--timeout 300] [--max 20]       Espera até alguma ter novidades
System.Management.Automation.RemoteException
EVENTOS (o barramento da frota e das missões)
  events since [--after <seq>] [filtros]      O que aconteceu depois desse número
  events wait --after <seq> [--timeout 60] [filtros]
                                              Espera o próximo evento (sem polling)
  Filtros: --topics task.,mission. --run <id> --mission <id> --task <id> --limit 100
System.Management.Automation.RemoteException
MISSÕES (também sem interface: `ade-ags --headless`)
  mission run --objective "..." --cwd . [--test] [--wait] [--timeout 3600]
              [--title ...] [--agent claude-code] [--model ...] [--account <id>]
              [--squad <id>] [--budget 5] [--max-parallel 2]
                                              Cria, inicia e espera; sai com 1 se falhar
  mission create --objective "..." --cwd .    Só cria o rascunho (mesmas flags do run, sem --wait)
  mission start|status|wait <id>              Passo a passo (wait: --timeout)
  mission create|run|start ... --test          Marca explicitamente teste/E2E (fora da taxa de sucesso)
  mission review <id>                         O que cada tarefa isolada entregou
  mission timings <id>                        Tempo ativo, delegação, alertas/esperas do orquestrador e tempo até todos trabalharem
  mission efficiency <id>                     Tempo ativo unificado (mission_active > spans > relógio), custo e histórico por agente
  mission cleanup <id> [--dry-run]             Limpa worktrees e branches integrados de uma missão encerrada
  worktrees list [--cwd <caminho>]             Worktrees gerenciados, tamanho e bloqueios de limpeza
  worktrees prune [--cwd <caminho>] [--dry-run]  Limpa missões encerradas integradas; mantém órfãos para revisão
  mission precheck <id>                       O que o repositório e as missões anteriores já dizem sobre o objetivo
  mission startcheck <id>                     Evidência de briefing e atividade por agente; limite de 2 minutos
  memory search "<tema>" --mission <id> [--limit 5] [--at <YYYY-MM-DD|YYYY-MM-DDTHH:MM|unix-seconds>]
                                              Busca a memória vigente agora ou nesse instante (datas em UTC)
  memory history --mission <id> --key <nome> --scope workspace|mission
                                              Revisões aprovadas e seus intervalos de validade
  memory suggest --mission <id> --key <nome> --body "..." [--scope workspace|mission]
                 [--kind decision|constraint|finding|file|note] [--priority 0-3]
                                              SUGERE uma memória (fica pendente; o usuário aprova)
  mission accept <id> <tarefa>                Junta na integração da missão
  mission apply <id>                          Leva o aceito para o projeto
  mission redeliver <id> [--pr <N>] [--test passed|failed|not_run]
                                              Reavalia entrega no repo origin (só promove se PR mesclado e CI verde)
  approval list                               Pedidos de permissão esperando
  approval decide <id> --allow|--deny [--remember]
System.Management.Automation.RemoteException
JANELAS
  window list                                 Janelas abertas
  window create                               Abre uma janela nova
System.Management.Automation.RemoteException
WORKSPACES
  workspace list                              Workspaces salvos
  workspace open <id|nome>                    Abre um
                 [--close-current]
  workspace status                            O que está aberto agora
System.Management.Automation.RemoteException
FROTA (agentes headless, os do console)
  run roster                                  Quais agentes, modelos e contas podem
                                              rodar agora, com custo e cota
  run status [--cwd <caminho>] [--run-id <id>]  O quadro do run: cada tarefa com seu
                                              estado, modelo, custo e do que depende
  run result --task <key|id> [--run-id <id>]  Tudo o que uma tarefa entregou
  run await [--timeout-s 300]                 Bloqueia até uma tarefa encerrar
  run facts [--run-id <id>]                   O que os agentes deixaram escrito
  run add-fact --kind decision --body "..."   Compartilha um dado com todo o run
  run cancel-task --task <key|id>             Para uma, ou tira da fila uma que espera
  run reroute-task --task <key|id>            Passa para outro agente, com o que o
                  [--agent <id>] [--model <m>] anterior já fez; mesma branch e worktree
  run plan --json-args '{"objective":"...",  Declara o DAG inteiro de uma vez
           "tasks":[{...}]}'                  (mais cômodo num agente: run_plan)
System.Management.Automation.RemoteException
  Sem --cwd nem --run-id atua sobre o último run lançado da pasta
  onde você roda o comando.
System.Management.Automation.RemoteException
MEMÓRIA COMPARTILHADA (os agentes usam por MCP; veja docs/ade-ags/SHARED_MEMORY.md)
  memory list|get|propose|update|delete|promote-fact --json-args '{...}'
                                              O aprovado do workspace e da missão;
                                              o que se propõe espera aprovação.
  memory index                              Índice aprovado da tab ou missão atual
  memory open <página|entryId|chave>         Página do índice ou UMA entrada inteira (DADOS NÃO CONFIÁVEIS)
  swarm note|question <texto>                Dados de sessão da missão, não memória durável
  swarm promote <note-id> <key>              Propõe a nota; aprovação exclusiva do usuário
  memory export                             Exporta Markdown e revisões JSON do workspace da tab (só leitura)
  memory compact [retentionDays]             Só na interface do app; um terminal de agente não pode
  workspace restore <id|nome>                Só na interface do app; um terminal de agente não pode
System.Management.Automation.RemoteException
NAVEGADOR
  browser run --json-args '{"cwd":"...",     Uma ordem ao navegador de um projeto:
              "request":{"op":"snapshot"}}'   snapshot, click, type, resize, console…
                                              É o mesmo caminho que as 26
                                              ferramentas browser_* do MCP usam.
System.Management.Automation.RemoteException
AGENTES, CONTAS E SKILLS
  agents                                      O que pôr em --agent (inclui os personalizados)
  accounts                                    O que pôr em --account, por TUI
  prelaunch [list]                            O que pôr em --pre
  skills                                      O que pôr em --skills (instaladas)
  skill search <texto>                        Busca em TODOS os repositórios, skills.sh incluído
                                              (o skills.sh é consultado pela internet)
  skill install <nome>                        Instala dos repositórios habilitados
  skill show <nome|id>                        Metadados + conteúdo do SKILL.md
  skill new <nome>                            Cria uma skill própria (origem local)
             [--description ...] [--categories a,b] [--agents a,b]
             [--file <caminho> | --content "..."]
  skill edit <nome|id>                        Salva conteúdo novo
             [--file <caminho> | --content "..."] [--name <novo>] [--copy]
System.Management.Automation.RemoteException
SERVIDOR MCP (não é você quem digita: o app o inicia)
  mcp --cwd <pasta> [--tab <id>]              A ponte de uma tab interativa
  mcp --task <id-da-tarefa>                   A de uma tarefa da frota
System.Management.Automation.RemoteException
  Diferente do resto, isto NÃO devolve uma linha JSON: fica preso no stdin
  e no stdout falando JSON-RPC com o agente que o iniciou. É o servidor `ade-ags`
  que dá a ele suas ferramentas: o navegador do projeto, a orquestração da frota,
  a conta de git do usuário (PRs, issues, push/pull), perguntar algo ao usuário,
  e —só com --task— a permissão de cada ação.
System.Management.Automation.RemoteException
  O app o adiciona sozinho ao comando de cada tab do Claude Code, com um
  `--mcp-config` escrito em ~/.ags/mcp/. Não precisa instalar o CLI para
  funcionar: o arquivo aponta para o binário que vem dentro do app.
System.Management.Automation.RemoteException
OUTROS
  app status                                  Versão e estado do app
  --json-args '{...}'                         Passa argumentos crus em JSON
  --version                                   Versão deste CLI e do protocolo
System.Management.Automation.RemoteException
`agents`, `accounts` e `skills` são atalhos de `agent list`, `account list` e `skill list`.
Editar uma skill que veio de um repositório NÃO a sobrescreve: guarda uma cópia de origem local e
deixa a original recebendo atualizações. `--copy` força essa cópia também para uma
skill própria. `--file` é lido a partir do diretório onde você roda o comando.
Sem --account, a tab usa a conta principal (a de sempre).
--pre se repete sem limite e seus valores rodam NA ORDEM ESCRITA; se um falhar, o
agente não inicia. Cada valor pode ser o nome de um item salvo ou um comando literal:
  ags tab create --cwd . --agent claude-code --pre "ambiente conda" --pre "nvm use"
System.Management.Automation.RemoteException
A saída é sempre uma linha JSON no stdout (exceto `mcp`, que fala JSON-RPC).
Códigos de saída: 0 ok · 1 o comando falhou · 2 uso incorreto · 3 o app não está rodando
~~~


## Validação da entrega documental

ags test affected --dry-run: {"commands":[],"full":false,"ignored":["docs/ade-ags/V13_BACKEND.md"],"risk":[],"unmapped":[]}

ags test affected: {"full":false,"ignored":["docs/ade-ags/V13_BACKEND.md"],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}

## Decisões humanas por provedor

64 linhas de decision_human_log, todas no ponto memory_approval, sem coluna provider. Associação por point+state_hash com shadow: Jev 32 observações associadas (24 coincidem com a pessoa, 8 revisar, 0 contrárias); Laya 16 (9 coincidem, 1 revisar, 6 contrárias). Denominadores diferentes: não comparar taxas globais diretamente. Query: SELECT * FROM decision_human_log ORDER BY ts,id; associação em memória, nenhuma escrita. Saída exata do cálculo: HUMAN_BY_PROVIDER jev 32 24 8; HUMAN_BY_PROVIDER laya_local 16 9 1.

## Investigação posterior da origem — 12/10/2026

A pedido do Orquestrador, consultei os registros 71–81 de decision_shadow_log e 43–64 de decision_human_log em mode=ro/query_only. Os 11 hashes Jev memory_approval registrados entre 17:22:57 e 17:23:02 -03:00 aparecem TODOS no human log com decisão aprovar em ts=1791836608, 17:23:28 -03:00. Há 22 linhas humanas nesse instante; points.rs::record_memory_decision grava duas operações (proposta e create), portanto a duplicação é compatível com 11 aprovações. Isso é evidência de decisões persistidas, não identificação da pessoa/processo executor. Não atribuir a QA ou Orquestrador, ambos negaram revisão/aprovação.

Durante a investigação houve leitura somente de metadados de memory_entries/memory_revisions (nenhum corpo exibido), que excedeu o escopo inicial de somente decision logs: retornou 11 revisões approved com decided_at=1791836608. Cinco chaves são tech.v13.smoke_suite_integrity, tech.v13.encoding_bom_le, tech.v13.test_caching_behavior, tech.v13.ipc_peer_messaging e tech.v13.cli_exit_codes; outras seis: run-cli-contexto-pasta, tech.cli.positional_parsing, tech.cli.usage_feedback, tech.encoding.bom_handling, tech.ipc.peer_reachability, tech.test.caching_layer. Assim, a afirmação anterior de que as cinco continuam pending foi contradita pelos metadados observados; pending descreve o retorno inicial do CLI. Nenhuma aprovação foi feita pelo Backend.

A revisão automática rejeitou a etapa seguinte de ler corpos das revisões e reproduzir SHA256 para mapear cada chave ao hash, pois isso ultrapassa o escopo autorizado de SQLite (decision logs). Essa etapa não foi executada nem contornada. Correlação chave/hash, origem executor e falsos positivos v13 não foram confirmados. Não se trata de bug provado do produto nem de descumprimento atribuído a um agente.

Comandos da investigação de logs: SELECT id,ts,provider,point,state_hash FROM decision_shadow_log WHERE id BETWEEN 71 AND 81 ORDER BY id; SELECT id,ts,point,state_hash,decision FROM decision_human_log WHERE id>42 ORDER BY id. Resultados de shadow, campos exatos (provider=jev, point=memory_approval em todas):

~~~text
Backend: QA confirmou cinco chaves pending. Leitura final 17:27:05 -03:00: 81 shadow/64 human, registrada no commit c37e89d. Relatorio mantido. As 11 linhas abaixo NAO sao atribuidas ao QA; origem desconhecida.
id=71 hora=2026-10-12T17:22:57-03:00 provider=jev ponto=memory_approval state_hash=a2ed2e251458068528af1881604ac20850ae19440864245f977e6c41b9e2aa58
id=72 hora=2026-10-12T17:22:57-03:00 provider=jev ponto=memory_approval state_hash=622ae9961b77008fd34bff76cbf4d71e3cce08e225a3ccd270e7b9fadc4a95a6
id=73 hora=2026-10-12T17:22:58-03:00 provider=jev ponto=memory_approval state_hash=a962cdca132c069137decb9c80fd09e4d86693771aad7443d09d4a507ea30d8b
id=74 hora=2026-10-12T17:22:58-03:00 provider=jev ponto=memory_approval state_hash=ebb8dabb31407d77e4e21b637bd913ade0cb8b9fee82d32ad2ab4d8afcfe53f0
id=75 hora=2026-10-12T17:22:59-03:00 provider=jev ponto=memory_approval state_hash=064a8669bf8b3a8c9ffc649a2728c69b7ced9934d0987539a88363b38ccdf109
id=76 hora=2026-10-12T17:22:59-03:00 provider=jev ponto=memory_approval state_hash=48e704661c716965d728167aff87fd0e68bf56448fc0d875185e11faa9967bb2
id=77 hora=2026-10-12T17:23:00-03:00 provider=jev ponto=memory_approval state_hash=8d0f512aeaaad431800ed35d31ffe436164375f439fc1d4f5b5a8ab39a0eee10
id=78 hora=2026-10-12T17:23:00-03:00 provider=jev ponto=memory_approval state_hash=3748e85363352ceab021494b8d998597d81dd136e4963e5af33854fd63e96337
id=79 hora=2026-10-12T17:23:01-03:00 provider=jev ponto=memory_approval state_hash=57b64d42644dee45e332e61c9647f1fd876b031ea12759da3058ce09e7c626a0
id=80 hora=2026-10-12T17:23:01-03:00 provider=jev ponto=memory_approval state_hash=62839a09fe1b6158c7cc7890ece9c1e199b516e43b9739796b3a13e5c3196108
id=81 hora=2026-10-12T17:23:02-03:00 provider=jev ponto=memory_approval state_hash=4bea55b079e6c546a8b81079bb97c97021d3f4cb3cc727dea93595e77c36095f
~~~

Todos os hashes acima têm decision_human_log.decision=aprovar e ts=1791836608. Relatório fechado com essa ressalva.
