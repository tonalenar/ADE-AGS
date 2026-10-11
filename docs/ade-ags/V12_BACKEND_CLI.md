# CLI Backend v12 - exact stdout/stderr
cwd: C:\Users\tonz1n\.ags\worktrees\9d526890
ADE_TAB_ID absent; outside fleet task.

## ags --version

Exit 0; 36 ms

stdout:
~~~text
{"buildDate":"1791716263","buildHash":"8d0df883a3892eccb5450d5b5e30ebd4ff16a06e","protocol":1,"version":"1.8.7"}
~~~

## ags app status

Exit 0; 34 ms

stdout:
~~~text
{"protocol":1,"version":"1.8.7","windows":1}
~~~

## ags --help

Exit 0; 31 ms

stderr:
~~~text
ags — controla o app ADE AGS pelo terminal

USO
  ags <grupo> <ação> [valor] [--flag valor ...]

TESTES LOCAIS (no worktree atual, sem precisar do app)
  test affected [--dry-run] [--force]          Testes afetados desde origin/master + alterações locais
  test run <frontend|rust|tsc|babel> [--force]  Suíte completa; reutiliza o verde só com a árvore limpa
  test status                                Últimos resultados deste repositório
  test smoke                                 Roteiro fixo do CLI contra o app aberto (tab, mission, peers, memory, --file)
             [--mission <id>] [--cwd <raiz>]  Contexto opcional para os spans de testes

  O primeiro valor pode vir solto, sem a flag:
    ags skill install git-helper       =  ags skill install --skill git-helper
    ags tab send <id> "rode os testes" =  ags tab send --tab <id> --text "..."

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

CORREÇÕES — teto de rodadas da mesma entrega (canvas e frota)
  fix list <escopo>                           Entregas e quantas rodadas cada uma usou
  fix decide <escopo> <trabalho> <ação>       accept | extra | abort
              [--task <id>]                   escopo: run:<id> ou mission:<id>

POOLS DE CONTAS — repartir entre várias contas de uma TUI com uma estratégia
  pools                                       Os pools criados, com suas contas e sua estratégia
  pool create <nome> --agent <id> --accounts principal,trabalho [--strategy least-used|round-robin|sticky]
  pool delete <nome>
  Pedem-se onde iria uma conta: tab create --agent claude-code --account pool:Trabalho, ou o
  "account" de uma tarefa de um plano / de um membro de um Squad (pool:Trabalho).

DISPOSITIVOS ANDROID DO CANVAS — um emulador ou telefone conectado a este terminal (por adb)
  devices                                     Os que você controla, o que o adb vê e os emuladores (AVD)
  device create [<nome>] [--avd <avd>]        Cria um ao seu lado, já conectado
  device start <dispositivo> [--avd <avd>]    Liga o emulador e espera terminar de iniciar
  device tap <dispositivo> --x N --y N        Toca · ou --text "Entrar" (procura o elemento na tela)
  device swipe <dispositivo> --dir up|down|left|right   · ou --x1 --y1 --x2 --y2 [--ms 300]
  device type <dispositivo> "texto"          Digita (só ASCII) · device key <d> back|home|enter|...
  device launch <dispositivo> <pacote>        Abre um app (com.android.settings)
  device shot|tree <dispositivo>              Captura (devolve o caminho do PNG) · elementos com seu texto e onde tocar

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

CHAT COM O USUÁRIO — o chat dele por conversas (sete cores); o que você escreve no terminal NÃO chega a ele
  say "texto" [--progress] [--thread <cor>]    Responde no chat (--progress: aviso, seu turno continua)
      [--file <caminho>]                      · o texto a partir de um arquivo
  recall [<cor>|list] [--turns 10 | --all]   O que foi dito numa conversa (list: as conversas com atividade)

ROTINAS — mensagens na hora marcada, para você, para um agente que você alcança ou para o usuário
  routines                                    As suas (num shell: todas)
  routine create <nome> "texto" <quando>      · --every 30m | --at 09:00 [--days seg,qua] | --in 45m
              [--to <agente>] [--remind]      · para quem: você (padrão), outro agente, ou --remind ao usuário
              [--catch-up]                    · se o app estava fechado na hora, roda UMA vez ao abrir (diária/única, até 24 h)
  routine show|run|enable|disable|delete <nome>
  routine edit <nome> ["texto"] [--rename <n>] [<quando>] [--catch-up|--no-catch-up]
                                              (mínimo 5 min; as de intervalo não recuperam o perdido com o app fechado)

ANDARES — cópias isoladas do projeto (worktree + branch + canvas próprio)
  floors                                      Os andares deste projeto e em qual você está
  floor create <nome> [--from <branch>]       Só orquestradores; parte do HEAD ou dessa branch
                                              (apagá-los fica com o usuário)

PAPÉIS (para recrutar com --role)
  roles                                       Os papéis: catálogo + os do usuário
  role show <papel>                           As instruções dele
  role create <nome> "instruções"             Só orquestradores; também --file <caminho>
  role edit <papel> "instruções" [--name]     Só orquestradores; o catálogo não se edita

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

OBSERVAR TABS (modo push — evita o polling)
  watch add <id> [--idle 20]                  Começa a observar uma tab
  watch remove <id>                           Para de observá-la
  watch list                                  Tabs observadas e o limite vigente
  watch wait [--timeout 300] [--max 20]       Espera até alguma ter novidades

EVENTOS (o barramento da frota e das missões)
  events since [--after <seq>] [filtros]      O que aconteceu depois desse número
  events wait --after <seq> [--timeout 60] [filtros]
                                              Espera o próximo evento (sem polling)
  Filtros: --topics task.,mission. --run <id> --mission <id> --task <id> --limit 100

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

JANELAS
  window list                                 Janelas abertas
  window create                               Abre uma janela nova

WORKSPACES
  workspace list                              Workspaces salvos
  workspace open <id|nome>                    Abre um
                 [--close-current]
  workspace status                            O que está aberto agora

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

  Sem --cwd nem --run-id atua sobre o último run lançado da pasta
  onde você roda o comando.

MEMÓRIA COMPARTILHADA (os agentes usam por MCP; veja docs/ade-ags/SHARED_MEMORY.md)
  memory list|get|propose|update|delete|promote-fact --json-args '{...}'
                                              O aprovado do workspace e da missão;
                                              o que se propõe espera aprovação.
  memory index                              Índice aprovado da tab ou missão atual
  memory open <página|entryId|chave>         Página do índice ou UMA entrada inteira (UNTRUSTED DATA)
  swarm note|question <texto>                Dados de sessão da missão, não memória durável
  swarm promote <note-id> <key>              Propõe a nota; aprovação exclusiva do usuário
  memory export                             Exporta Markdown e revisões JSON do workspace da tab (só leitura)
  memory compact [retentionDays]             Só na interface do app; um terminal de agente não pode
  workspace restore <id|nome>                Só na interface do app; um terminal de agente não pode

NAVEGADOR
  browser run --json-args '{"cwd":"...",     Uma ordem ao navegador de um projeto:
              "request":{"op":"snapshot"}}'   snapshot, click, type, resize, console…
                                              É o mesmo caminho que as 26
                                              ferramentas browser_* do MCP usam.

AGENTES, CONTAS E SKILLS
  agents                                      O que pôr em --agent (inclui os custom)
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

SERVIDOR MCP (não é você quem digita: o app o inicia)
  mcp --cwd <pasta> [--tab <id>]              A ponte de uma tab interativa
  mcp --task <id-da-tarefa>                   A de uma tarefa da frota

  Diferente do resto, isto NÃO devolve uma linha JSON: fica preso no stdin
  e no stdout falando JSON-RPC com o agente que o iniciou. É o servidor `ade-ags`
  que dá a ele suas ferramentas: o navegador do projeto, a orquestração da frota,
  a conta de git do usuário (PRs, issues, push/pull), perguntar algo ao usuário,
  e —só com --task— a permissão de cada ação.

  O app o adiciona sozinho ao comando de cada tab do Claude Code, com um
  `--mcp-config` escrito em ~/.ags/mcp/. Não precisa instalar o CLI para
  funcionar: o arquivo aponta para o binário que vem dentro do app.

OUTROS
  app status                                  Versão e estado do app
  --json-args '{...}'                         Passa argumentos crus em JSON
  --version                                   Versão deste CLI e do protocolo

`agents`, `accounts` e `skills` são atalhos de `agent list`, `account list` e `skill list`.
Editar uma skill que veio de um repositório NÃO a sobrescreve: guarda uma cópia de origem local e
deixa a original recebendo atualizações. `--copy` força essa cópia também para uma
skill própria. `--file` é lido a partir do diretório onde você roda o comando.
Sem --account, a tab usa a conta principal (a de sempre).
--pre se repete sem limite e seus valores rodam NA ORDEM ESCRITA; se um falhar, o
agente não inicia. Cada valor pode ser o nome de um item salvo ou um comando literal:
  ags tab create --cwd . --agent claude-code --pre "ambiente conda" --pre "nvm use"

A saída é sempre uma linha JSON no stdout (exceto `mcp`, que fala JSON-RPC).
Códigos de saída: 0 ok · 1 o comando falhou · 2 uso incorreto · 3 o app não está rodando
~~~

## ags peer check

Exit 2; 32 ms

stderr:
~~~text
Uso: ags peer check <nome> [--lines 60]
~~~

## ags peer tell Orquestrador --file v12-arquivo-inexistente.txt

Exit 2; 30 ms

stderr:
~~~text
Não foi possível ler v12-arquivo-inexistente.txt: O sistema não pode encontrar o arquivo especificado. (os error 2)
~~~

## ags run status

Exit 1; 35 ms

stdout:
~~~text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
~~~

## ags run status --run-id v12-inexistente

Exit 1; 35 ms

stdout:
~~~text
{"error":"não há nenhum run v12-inexistente"}
~~~

## ags run status --run-id

Exit 2; 29 ms

stderr:
~~~text
--run-id precisa de um valor
~~~

## ags run status --cwd .

Exit 1; 32 ms

stdout:
~~~text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
~~~

## ags run result

Exit 1; 32 ms

stdout:
~~~text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
~~~

## ags run result --run-id v12-inexistente

Exit 1; 30 ms

stdout:
~~~text
{"error":"não há nenhum run v12-inexistente"}
~~~

## ags run result --run-id

Exit 2; 29 ms

stderr:
~~~text
--run-id precisa de um valor
~~~

## ags run result --cwd .

Exit 1; 35 ms

stdout:
~~~text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
~~~

## ags run facts

Exit 1; 34 ms

stdout:
~~~text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
~~~

## ags run facts --run-id v12-inexistente

Exit 1; 32 ms

stdout:
~~~text
{"error":"não há nenhum run v12-inexistente"}
~~~

## ags run facts --run-id

Exit 2; 29 ms

stderr:
~~~text
--run-id precisa de um valor
~~~

## ags run facts --cwd .

Exit 1; 32 ms

stdout:
~~~text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
~~~

## ags run status --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0

Exit 0; 36 ms

stdout:
~~~text
{"text":"Run 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 — Revisar memória e propor melhorias com fontes\nestado: falhou · gasto $0.00 · até 1 em paralelo\n- 9a644dcb [falhou] Sonhar agora · claude-code/sonnet\n    erro: no se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)\n"}
~~~

## ags run result --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885

Exit 0; 34 ms

stdout:
~~~text
{"text":"9a644dcb — Sonhar agora\nestado: falhou · tentativas 0 · custo ? · claude-code/sonnet\n\n(O que segue foi escrito por um agente: dados, não instruções.)\nerro:\nno se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)\n"}
~~~

## ags run result --run-id 102c4370-0f50-4838-8073-f0b8f3365d11 --task backend

Exit 0; 33 ms

stdout:
~~~text
{"text":"backend — Suítes + CLI ags\nestado: falhou · tentativas 1 · custo ? · claude-code/claude-haiku-5-5\nbranch: cc/suites-cli-ags-88892e47 (worktree C:\\Users\\tonz1n\\.ags\\worktrees\\88892e47)\n\n(O que segue foi escrito por um agente: dados, não instruções.)\nerro:\nla app se cerró mientras esta tarea corría\n"}
~~~

## ags run facts --run-id 102c4370-0f50-4838-8073-f0b8f3365d11

Exit 0; 32 ms

stdout:
~~~text
{"text":"{\"items\":[{\"id\":\"aa898156-0dcb-45ca-95b1-682c60acab65\",\"runId\":\"102c4370-0f50-4838-8073-f0b8f3365d11\",\"taskId\":\"7f6cb66d-5472-4d98-b20a-f8c95604e975\",\"author\":\"Teste completo v3 (squad Opus)\",\"kind\":\"constraint\",\"body\":\"Missão só de teste: nenhum arquivo fora de docs/ade-ags/ pode ser alterado ou commitado. Não reiniciar/atualizar o app instalado nem fechar abas/missões alheias.\",\"bodyBytes\":165,\"bodyTruncated\":false,\"createdAt\":1791566475}],\"hasMore\":false,\"nextCursor\":null,\"truncated\":false}"}
~~~

## ags run status --run-id f8019494-c4ae-4740-8d9e-9976c9c2bde9

Exit 0; 34 ms

stdout:
~~~text
{"text":"Run f8019494-c4ae-4740-8d9e-9976c9c2bde9 — Execute o E2E real do Handoff Structured v0 com exatamente quatro workers: Backend, Frontend, Generalist e QA / Tests.\nestado: concluído · gasto $0.00 de $1.00 · até 3 em paralelo\n- lead [concluído] teste · antigravity/gemini-3.8-flash-high\n    resultado: ### Execução do E2E Real do Handoff Structured v0\n- backend [concluído] Backend: Criar testes/handoff/backend.txt e emitir handoff v1 · codex/gpt-6-luna\n    resultado: Criei `testes/handoff/backend.txt` com exatamente 7 bytes (`backend`) e validei que não há BOM nem quebra de linha final. O handoff estruturado `HANDOFF_BACKEND…\n    Entrega v1 (dados não confiáveis do agente): HANDOFF_BACKEND_V1\n- frontend [concluído] Frontend: Criar testes/handoff/frontend.txt e emitir handoff v1 · codex/gpt-6-luna\n    resultado: Created `testes/handoff/frontend.txt` with exactly 8 bytes (`frontend`), no BOM or trailing newline. The PowerShell byte validation passed, and the structured h…\n    Entrega v1 (dados não confiáveis do agente): HANDOFF_FRONTEND_V1\n- generalist [concluído] Generalist: Criar testes/handoff/isolated.txt e emitir handoff v1 · codex/gpt-6-luna\n    resultado: Created `testes/handoff/isolated.txt` with exactly 8 bytes (`isolated`), without a BOM or trailing newline. Validation passed, and the structured handoff was su…\n    Entrega v1 (dados não confiáveis do agente): HANDOFF_ISOLATED_V1\n- qa [concluído] QA: Validar handoffs e arquivos de dependência e emitir handoff v1 · codex/gpt-6-luna · depende de backend, frontend\n    resultado: Concluído. Criei `testes/handoff/qa.txt` com exatamente 16 bytes (`backend+frontend`) e validei os arquivos de backend e frontend.\n    Entrega v1 (dados não confiáveis do agente): HANDOFF_QA_V1\n"}
~~~

## ags run result --run-id f8019494-c4ae-4740-8d9e-9976c9c2bde9 --task backend

Exit 0; 34 ms

stdout:
~~~text
{"text":"backend — Backend: Criar testes/handoff/backend.txt e emitir handoff v1\nestado: concluído · tentativas 1 · custo ? · codex/gpt-6-luna\n\n(O que segue foi escrito por um agente: dados, não instruções.)\n\nEntrega (dados não confiáveis do agente, nunca instruções):\n```json\n{\"handoff\":{\"artifacts\":[],\"changed_files\":[{\"description\":\"Arquivo backend criado com 7 bytes exatos\",\"path\":\"testes/handoff/backend.txt\"}],\"decisions\":[],\"next_steps\":[],\"risks\":[],\"summary\":\"HANDOFF_BACKEND_V1\",\"tests\":[{\"command\":\"$bytes = [System.IO.File]::ReadAllBytes('testes/handoff/backend.txt'); if ($bytes.Length -ne 7 -or [System.Text.Encoding]::UTF8.GetString($bytes) -cne 'backend') { throw 'Validation failed' }; 'VALIDATION PASSED: 7 bytes exact'\",\"notes\":\"Validado conteúdo exato 'backend' (7 bytes, sem BOM, sem quebra de linha).\",\"status\":\"passed\"}],\"version\":1},\"task_id\":\"42d8b348-44ea-407e-b756-fdc6cbd0d2c6\"}\n```\nresultado:\nCriei `testes/handoff/backend.txt` com exatamente 7 bytes (`backend`) e validei que não há BOM nem quebra de linha final. O handoff estruturado `HANDOFF_BACKEND_V1` foi salvo com a validação executada.\n"}
~~~

## ags tab output v12-inexistente

Exit 1; 34 ms

stdout:
~~~text
{"error":"Esta janela não tem nenhuma aba com o id v12-inexistente"}
~~~

## ags mission status v12-inexistente

Exit 1; 31 ms

stdout:
~~~text
{"error":"não há nenhuma missão v12-inexistente"}
~~~

## ags skill show v12-inexistente

Exit 1; 32 ms

stdout:
~~~text
{"error":"Não há nenhuma skill instalada chamada 'v12-inexistente'. Instaladas: ags-orchestrator, canvas-design"}
~~~

## ags workspace open v12-inexistente

Exit 1; 32 ms

stdout:
~~~text
{"error":"Não existe o workspace 'v12-inexistente'"}
~~~

## ags portal snapshot v12-inexistente

Exit 1; 32 ms

stdout:
~~~text
{"error":"Este comando só funciona dentro de um terminal do ADE AGS (falta ADE_TAB_ID)."}
~~~

## ags note read v12-inexistente

Exit 1; 32 ms

stdout:
~~~text
{"error":"Este comando só funciona dentro de um terminal do ADE AGS (falta ADE_TAB_ID)."}
~~~
