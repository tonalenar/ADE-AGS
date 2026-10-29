//! CLI `ade-ags` — Fase 8.
//!
//! Habla con la instancia de la app que esté corriendo (ver `ipc::protocol`). Toda la
//! salida va a stdout como JSON en una línea, para que un agente la parsee sin heurísticas;
//! los mensajes para humanos (ayuda, errores de uso) van a stderr.
//!
//! El código de salida distingue los casos que a un agente le importan: 0 todo bien,
//! 1 la app rechazó el comando, 2 error de uso, 3 la app no está corriendo.

use ade_ags_lib::ipc::protocol::{client_handshake_path, Handshake, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Map, Value};
use std::process::ExitCode;
use std::time::{Duration, Instant};

const EXIT_OK: u8 = 0;
const EXIT_COMMAND_FAILED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_NO_APP: u8 = 3;

const USAGE: &str = "\
ags — controla o app ADE AGS pelo terminal

USO
  ags <grupo> <ação> [valor] [--flag valor ...]

TESTES LOCAIS (no worktree atual, sem precisar do app)
  test affected [--dry-run] [--force]          Testes afetados desde a base do worktree + alterações locais
  test run <frontend|rust|tsc|babel> [--force]  Suíte completa; reutiliza o verde só com a árvore limpa
  test status                                Últimos resultados deste repositório
  test smoke                                 Roteiro fixo do CLI contra o app aberto (tab, mission, peers, memory, --file)
             [--mission <id>] [--cwd <raiz>]  Contexto opcional para os spans de testes

  O primeiro valor pode vir solto, sem a flag:
    ags skill install git-helper       =  ags skill install --skill git-helper
    ags tab send <id> \"rode os testes\" =  ags tab send --tab <id> --text \"...\"

TABS
  tab list                                    Tabs abertas agora (com o estado do transcript, se houver)
  tab state <id>                              O estado lido do transcript da TUI (Claude Code, Codex):
                                              turno aberto/encerrado, ferramentas pendentes, pergunta, tokens
  tab create <caminho> --agent <id>           Abre uma tab nova
             [--skills a,b]                   · skills a anexar, por nome
             [--account <nome>]               · conta dessa TUI (veja `accounts`)
             [--pre <comando|salvo>]          · a executar ANTES do agente; repetível
             [--pre-preset <nome>]            · força que seja um item salvo, não um comando
             [--initprompt \"...\"]             · prompt inicial, enviado com Enter
             [--window <label>]                 quando a TUI terminou de iniciar
  tab close <id>                              Fecha uma tab
  tab output <id> [--lines 40]                O que é NOVO desde a leitura anterior,
             [--full] [--raw]                 comprimido (erros, avisos, final)
  tab send <id> \"...\" [--no-enter]            Escreve no terminal dela (+ Enter) —
                                              assim a conversa segue com
                                              uma tab que já está aberta

AGENTES CONECTADOS (canvas) — só alcança os conectados a este terminal
  peers                                       Quem está conectado a você
  peer ask <nome> \"...\" [--timeout 600]      Pergunta e ESPERA a resposta (orquestrador: 90 s por padrão)
  peer tell <nome> \"...\"                      Entrega e volta já: encerre o turno; a resposta chega depois
             [--task \"...\"]                    · envelope tipado (tell/ask): o destino lê \"X pediu sua ajuda nisto.
             [--constraints \"...\"]             · Tarefa / Restrições / Como é uma boa resposta\"; o texto livre vira contexto
             [--expecting \"...\"]
             (recusas de política — destino errado ou ambíguo, si mesmo, repetida, teto — saem com exit 0 e
              {refused:true, reason, message}; tetos: profundidade 2 e 5 pedidos novos por 10 min, 15 no orquestrador)
  peer tell <nome> --file <caminho>           O mesmo, com o texto em um arquivo (sem confusão de aspas no Windows)
  peer ask <nome> --file <caminho>            O mesmo que ask, com a pergunta em um arquivo
             (ask/tell --raw: o texto como está, sem o cabeçalho \"[Mensagem de ...]\"; para
              mandar a uma TUI um comando dela, p. ex. /compact ou /clear)
  peer ask --batch '{\"A\":\"...\",\"B\":\"...\"}'  Pergunta a vários AO MESMO TEMPO e espera todos
  peer check <nome> [--lines 60]              O que aparece agora no terminal dele
  peer deliver [<nome>] --file entrega.json   Entrega final estruturada (Handoff v1) ao orquestrador
                                              (ou a <nome>): ele recebe uma linha com o resumo e o id
  peer handoff <id>                           O JSON inteiro de uma entrega da sua missão
             (tell/ask/deliver --id <req>: o seu id do pedido. O mesmo id é a mesma mensagem:
              nunca é digitada duas vezes, nem num reenvio depois de um reinício do app)
  peer queue [list]                           O que você mandou e ainda espera na fila (id, destino, idade)
  peer queue refused                          As suas últimas recusas (motivo e a frase)
  peer queue cancel <id>                      Cancela uma mensagem sua que ainda não foi entregue
  peer pending [--all]                        Aprovações e perguntas dos integrantes que esperam resposta
  peer answer <id> <resposta> [--enter]       Responde uma pendência (só orquestradores): num diálogo, o número
                                              da opção, y, n ou esc; numa pergunta de fim de turno, o texto
  ci watch <PR>                               Segue o CI do PR em segundo plano e cola o resultado
                                              no seu terminal quando terminar (no lugar de gh pr checks --watch)
  notify \"mensagem\"                           Avisa o usuário (aviso na tela; barra de tarefas)
  Só orquestradores (coroa no canvas):
  peer recruit <nome> [--agent <id>]          Abre um agente novo, já conectado
              [--prompt \"...\"] [--account <n>]  · com a primeira tarefa
              [--role <papel>]                  · com um papel (veja roles)
              [--model <id>] [--effort <nível>] · com esse modelo e esforço (ex.: --model gpt-6.1-luna --effort max)
                                                Sem eles, usa o subagente padrão do Squad da missão (se houver);
                                                --model/--effort explícitos sempre vencem. Sem --agent, o do padrão
              [--fast]                          · modo Fast do Codex (só --agent codex)
              [--floor <andar>]                 · nesse andar (ou `ground`, o térreo)
  peer connect <a> <b>                        Conecta dois agentes da equipe
  peer disconnect <a> <b>                     Desconecta os dois
  peer role <nome> <papel> [--subagent]       Define o papel de um agente da equipe (os sem papel esperam por isso)

CORREÇÕES — teto de rodadas da mesma entrega (canvas e frota)
  fix list <escopo>                           Entregas e quantas rodadas cada uma usou
  fix decide <escopo> <trabalho> <ação>       accept | extra | abort
              [--task <id>]                   escopo: run:<id> ou mission:<id>

POOLS DE CONTAS — repartir entre várias contas de uma TUI com uma estratégia
  pools                                       Os pools criados, com suas contas e sua estratégia
  pool create <nome> --agent <id> --accounts principal,trabalho [--strategy least-used|round-robin|sticky]
  pool delete <nome>
  Pedem-se onde iria uma conta: tab create --agent claude-code --account pool:Trabalho, ou o
  \"account\" de uma tarefa de um plano / de um membro de um Squad (pool:Trabalho).

DISPOSITIVOS DO CANVAS — um Android (emulador ou telefone, por adb) ou um simulador iOS conectado a este terminal
  devices                                     Os que você controla, o que o adb vê, os emuladores (AVD) e os iPhones/iPads do Xcode
  device create [<nome>] [--avd <avd>]        Cria um ao seu lado, já conectado · --ios [\"iPhone 18 Pro Max\"] = simulador iOS
  device start <dispositivo> [--avd <avd>]    Liga o emulador e espera terminar de iniciar
  device tap <dispositivo> --x N --y N        Toca · ou --text \"Entrar\" (procura o elemento na tela)
  device swipe <dispositivo> --dir up|down|left|right   · ou --x1 --y1 --x2 --y2 [--ms 300]
  device type <dispositivo> \"texto\"          Digita (só ASCII) · device key <d> back|home|enter|...
  device launch <dispositivo> <pacote>        Abre um app (com.android.settings)
  device close <dispositivo> <pacote>         Fecha o app (com.apple.mobilesafari no iOS)
  device shot|tree <dispositivo>              Captura (devolve o caminho do PNG) · elementos com seu texto e onde tocar
  Só no iOS (coordenadas em pontos do iOS, as do `shot`):
  device open <dispositivo> <url>             Abre a URL no Safari do aparelho (localhost funciona)
  device button <dispositivo> home|lock|side|siri   Aperta um botão físico
  device say <dispositivo> \"mensagem\"         Responde na conversa do simulador (a pessoa e os outros agentes veem)

PORTAIS DO CANVAS — navegadores conectados a este terminal (orquestrador: os da equipe)
  portals                                     Os portais que você controla, cada um com seu estado: pronto, carregando, sem runtime,
                                              oculto (janela escondida ou nó fora de vista), verificação anti-robô ou sem resposta (+ dica do que fazer)
  portal create [<nome>] [<url>] [--new]      Abre um navegador ao seu lado, já conectado. Reaproveita o que já está aberto com você
                                              (ou o que ficou sem dono no canvas) e só navega; --new abre outro (no máx. 4)
  portal close <portal>                       Fecha um portal conectado com você (limpe o que criou ao terminar)
  open <url>                                  Abre um site: localhost vai para um navegador do canvas (reaproveita o da mesma origem), o resto para o navegador do sistema
  portal navigate <portal> <url>              Vai a uma URL
  portal snapshot <portal> [--full]           A árvore da página, com refs (@e3)
  portal click|hover <portal> <@ref|seletor>
  portal type <portal> <@ref> \"texto\" [--clear] [--submit]
  portal press <portal> <tecla> [--target <ref>]   · scroll · select · wait · history
  portal screenshot|console|layout <portal>   Foto, console e medidas
                                              (sem eval, upload nem cookies: isso é do usuário)
  portal reset <portal>                       Zera o site aberto no portal (cookies, storage) e o histórico dos act: recarregue depois
  portal act <portal> \"objetivo\" [--fill campo=valor]... [--expect tipo:valor]... [--steps 8]
                                              O Jev navega sozinho até o objetivo, passo a passo (Ajustes → Decisões → Navegador do canvas)
                                              Prefira UM act com o trajeto inteiro (--steps até 15): cada chamada extra custa um turno seu

CHAT COM O USUÁRIO — o chat dele por conversas (sete cores); o que você escreve no terminal NÃO chega a ele
  say \"texto\" [--progress] [--thread <cor>]    Responde no chat (--progress: aviso, seu turno continua)
      [--file <caminho>]                      · o texto a partir de um arquivo
  recall [<cor>|list] [--turns 10 | --all]   O que foi dito numa conversa (list: as conversas com atividade)

ROTINAS — mensagens na hora marcada, para você, para um agente que você alcança ou para o usuário
  routines                                    As suas (num shell: todas)
  routine create <nome> \"texto\" <quando>      · --every 30m | --at 09:00 [--days seg,qua] | --in 45m
              [--to <agente>] [--remind]      · para quem: você (padrão), outro agente, ou --remind ao usuário
              [--catch-up]                    · se o app estava fechado na hora, roda UMA vez ao abrir (diária/única, até 24 h)
  routine show|run|enable|disable|delete <nome>
  routine edit <nome> [\"texto\"] [--rename <n>] [<quando>] [--catch-up|--no-catch-up]
                                              (mínimo 5 min; as de intervalo não recuperam o perdido com o app fechado)

ANDARES — cópias isoladas do projeto (worktree + branch + canvas próprio)
  floors                                      Os andares deste projeto e em qual você está
  floor create <nome> [--from <branch>]       Só orquestradores; parte do HEAD ou dessa branch
                                              (apagá-los fica com o usuário)

PAPÉIS (para recrutar com --role)
  roles                                       Os papéis: catálogo + os do usuário
  role show <papel>                           As instruções dele
  role create <nome> \"instruções\"             Só orquestradores; também --file <caminho>
  role edit <papel> \"instruções\" [--name]     Só orquestradores; o catálogo não se edita

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
  note create [\"texto\"] [--name <n>]          Cria uma nota ao seu lado, já conectada
              [--stack <nota>]                · em vez de ao lado: dentro da pilha dessa nota (dividem o lugar)
              [--file <caminho>]              · o conteúdo a partir de um arquivo
  note read <nota> [desde] [quantidade]       Lê com números de linha
  note write <nota> \"texto\" [--file <caminho>]  Substitui todo o conteúdo
  note edit <nota> \"antigo\" \"novo\"           Troca um trecho que aparece UMA vez

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
  mission run --objective \"...\" --cwd . [--test] [--wait] [--timeout 3600]
              [--title ...] [--agent claude-code] [--model ...] [--account <id>]
              [--squad <id>] [--budget 5] [--max-parallel 2]
                                              Cria, inicia e espera; sai com 1 se falhar
  mission create --objective \"...\" --cwd .    Só cria o rascunho (mesmas flags do run, sem --wait)
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
  memory search \"<tema>\" --mission <id> [--limit 5] [--at <YYYY-MM-DD|YYYY-MM-DDTHH:MM|unix-seconds>]
                                              Busca a memória vigente agora ou nesse instante (datas em UTC)
  memory history --mission <id> --key <nome> --scope workspace|mission
                                              Revisões aprovadas e seus intervalos de validade
  memory suggest [--mission <id>] --key <nome> --body \"...\" [--scope workspace|mission]
                 [--kind decision|constraint|finding|file|note] [--priority 0-3]
                                              SUGERE uma memória (fica pendente; o usuário aprova); fora de missão, só --scope workspace
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
  run add-fact --kind decision --body \"...\"   Compartilha um dado com todo o run
  run cancel-task --task <key|id>             Para uma, ou tira da fila uma que espera
  run reroute-task --task <key|id>            Passa para outro agente, com o que o
                  [--agent <id>] [--model <m>] anterior já fez; mesma branch e worktree
  run plan --json-args '{\"objective\":\"...\",  Declara o DAG inteiro de uma vez
           \"tasks\":[{...}]}'                  (mais cômodo num agente: run_plan)

  Sem --cwd nem --run-id atua sobre o último run lançado da pasta
  onde você roda o comando.

MEMÓRIA COMPARTILHADA (os agentes usam por MCP; veja docs/ade-ags/SHARED_MEMORY.md)
  memory list|get|propose|update|delete|promote-fact --json-args '{...}'
                                              O aprovado do workspace e da missão;
                                              o que se propõe espera aprovação.
  memory index                              Índice aprovado da tab ou missão atual
  memory usage [--since <unix-seconds>]      Quem leu a memória: buscas, aberturas e memórias nunca lidas
  memory open <página|entryId|chave>         Página do índice ou UMA entrada inteira (DADOS NÃO CONFIÁVEIS)
  swarm note|question <texto>                Dados de sessão da missão, não memória durável
  swarm read                                  O quadro da missão: as notas publicadas, numeradas (#1, #2...)
  swarm promote <note-id> <key>              Propõe a nota; aprovação exclusiva do usuário
  memory export                             Exporta Markdown e revisões JSON do workspace da tab (só leitura)
  memory compact [retentionDays]             Só na interface do app; um terminal de agente não pode
  workspace restore <id|nome>                Só na interface do app; um terminal de agente não pode

NAVEGADOR
  browser run --json-args '{\"cwd\":\"...\",     Uma ordem ao navegador de um projeto:
              \"request\":{\"op\":\"snapshot\"}}'   snapshot, click, type, resize, console…
                                              É o mesmo caminho que as 26
                                              ferramentas browser_* do MCP usam.

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
             [--file <caminho> | --content \"...\"]
  skill edit <nome|id>                        Salva conteúdo novo
             [--file <caminho> | --content \"...\"] [--name <novo>] [--copy]

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

GEMINI DESKTOP (Windows; consultas assistidas)
  gemini status                               Estado do aplicativo original
  gemini consult --cwd . --prompt \"...\"        Registrar um pedido para o painel Gemini
  gemini result <id>                          Ler o estado e a resposta entregue

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
  ags tab create --cwd . --agent claude-code --pre \"ambiente conda\" --pre \"nvm use\"

A saída é sempre uma linha JSON no stdout (exceto `mcp`, que fala JSON-RPC).
Códigos de saída: 0 ok · 1 o comando falhou · 2 uso incorreto · 3 o app não está rodando
";

pub(crate) fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
        eprint!("{USAGE}");
        return ExitCode::from(if args.is_empty() { EXIT_USAGE } else { EXIT_OK });
    }
    // `ags tab --help`, `ags mission create --help`: ayuda, no un comando que viaja a la app.
    if args[0] != "mcp" && args.iter().any(|a| a == "--help") {
        eprint!("{USAGE}");
        return ExitCode::from(EXIT_OK);
    }
    if args[0] == "--version" || args[0] == "-V" {
        let mut version = ade_ags_lib::build_info::current();
        version["protocol"] = json!(PROTOCOL_VERSION);
        println!("{version}");
        return ExitCode::from(EXIT_OK);
    }

    // `ags mcp` se atiende antes que nada: no devuelve una línea JSON como el resto,
    // sino que se queda con stdin y stdout hablando JSON-RPC con el agente que lo lanzó.
    // Mezclarlo con el parseo de flags normal le ensuciaría el canal.
    if args[0] == "mcp" {
        return run_mcp(&args[1..]);
    }

    // `ags skills` / `ags agents`: listar es lo único que se hace con ellos, y exigir
    // `skill list` para eso era ceremonia sin ganancia.
    let (command, flag_args) = if args[0] == "design" {
        match design_command(&args) {
            Ok(v) => v,
            Err(e) => { eprintln!("{e}"); return ExitCode::from(EXIT_USAGE); }
        }    } else if args[0].starts_with("http://") || args[0].starts_with("https://") {
        // `ags http://localhost:5173`: é como as ferramentas que respeitam $BROWSER (Vite, Python…) chamam
        // o "navegador": a app põe BROWSER=ags nos terminais, e o endereço chega como único argumento.
        ("portal.open".to_string(), &args[..])
    } else { match shortcut(&args[0]) {
        Some(cmd) => {
            // `ags prelaunch` y `ags prelaunch list` son lo mismo. Escribir la accion
            // igual es lo natural para quien viene de `ags account list`, y sin esto
            // fallaba con "argumento inesperado 'list'" — un error sin sentido para algo
            // que es exactamente lo que el atajo hace.
            let action = cmd.split('.').nth(1).unwrap_or("");
            let rest = match args.get(1) {
                Some(next) if next == action => &args[2..],
                _ => &args[1..],
            };
            (cmd.to_string(), rest)
        }
        None => {
            if args.len() < 2 {
                eprintln!("Falta a ação para '{}'. Tente: ags --help", args[0]);
                return ExitCode::from(EXIT_USAGE);
            }
            (format!("{}.{}", args[0], args[1]), &args[2..])
        }
    }
    };

    // Compactar e restaurar só rodam na interface. Recusar aqui também: um `ags`
    // antigo não é a barreira, o servidor é, mas a mensagem chega sem depender dele.
    if let Some(error) = ade_ags_lib::ipc::agent_maintenance_error(&command) {
        println!("{}", json!({ "error": error }));
        return ExitCode::from(EXIT_COMMAND_FAILED);
    }

    let parsed = match parse_flags(flag_args, positionals(&command)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    if let Err(error) = validate_usage(&command, &parsed) {
        eprintln!("{error}");
        return ExitCode::from(EXIT_USAGE);
    }

    // `--file` se resuelve ACÁ y viaja como `--content`: el archivo es relativo al cwd de
    // quien escribió el comando, no al de la app, y la app puede estar corriendo desde
    // cualquier otro lado. Además evita que el backend tenga que abrir rutas arbitrarias.
    let parsed = match inline_file(parsed, &command) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    // `ags test smoke` fala com o app aberto (não roda suítes), então vem antes dos testes locais.
    if command == "test.smoke" {
        return smoke::run();
    }

    // Tests belong to the caller's worktree, not to the running app's cwd or
    // Cargo target. They also work when the app is offline.
    if command.starts_with("test.") {
        return execute_tests(&command, &parsed);
    }

    // Quién pregunta: la app le pone `ADE_TAB_ID` a cada terminal. Sin eso, la regla de
    // "solo a los conectados" no tendría contra qué comparar.
    let parsed = if command.starts_with("design.") {
        let cwd = match std::env::current_dir() {
            Ok(cwd) => cwd,
            Err(e) => { eprintln!("{e}"); return ExitCode::from(EXIT_USAGE); }
        };
        design_defaults(&command, parsed, &cwd)
    } else { parsed };
    let parsed = if command.starts_with("run.") {
        let cwd = match std::env::current_dir() {
            Ok(cwd) => cwd,
            Err(error) => {
                eprintln!("Não foi possível ler a pasta atual: {error}");
                return ExitCode::from(EXIT_USAGE);
            }
        };
        match run_defaults(parsed, &cwd) {
            Ok(args) => args,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::from(EXIT_USAGE);
            }
        }
    } else { parsed };
    let mut parsed=parsed;
    if command.starts_with("worktrees.") || command == "gemini.consult" {
        let requested=parsed.get("cwd").and_then(Value::as_str).unwrap_or(".");
        match std::path::absolute(requested) {
            Ok(path)=>{parsed["cwd"]=Value::String(path.to_string_lossy().into_owned());},
            Err(e)=>{eprintln!("{e}");return ExitCode::from(EXIT_USAGE);}
        }
    }
    let parsed = with_caller(&command, parsed);

    match send(&command, parsed.clone()) {
        Ok(response) if response.ok => {
            let body = response.data.unwrap_or(Value::Null);
            println!("{body}");
            ExitCode::from(EXIT_OK)
        }
        Ok(response) => {
            let err = response.error.unwrap_or_default();
            if command == "mission.redeliver" && (err.contains("desconocido") || err.contains("desconhecido")) {
                return execute_standalone_redeliver(&parsed);
            }
            println!("{}", json!({ "error": err }));
            // Un argumento obligatorio que falta es un error de USO (2), no un comando que falló (1).
            // Um flag com valor inválido (`--limit banana`, `--at 2026-13-99`) também é uso incorreto:
            // a própria mensagem nomeia o flag, e a automação precisa distinguir isso de uma falha real.
            if err.starts_with("Falta o argumento --") || err.starts_with("--") {
                return ExitCode::from(EXIT_USAGE);
            }
            ExitCode::from(EXIT_COMMAND_FAILED)
        }
        Err(e) => {
            if command == "mission.redeliver" {
                return execute_standalone_redeliver(&parsed);
            }
            println!("{}", json!({ "error": e.message }));
            ExitCode::from(e.code)
        }
    }
}

fn execute_tests(command: &str, args: &Value) -> ExitCode {
    match execute_tests_inner(command, args) {
        Ok((body, passed)) => { println!("{body}"); ExitCode::from(if passed { EXIT_OK } else { EXIT_COMMAND_FAILED }) }
        Err(error) => { println!("{}", json!({"error":error})); ExitCode::from(EXIT_COMMAND_FAILED) }
    }
}

fn execute_tests_inner(command: &str, args: &Value) -> Result<(Value, bool), String> {
    use ade_ags_lib::testspeed::run as test_runner;
    use rusqlite::OptionalExtension;
    let cwd = args.get("cwd").and_then(Value::as_str).map(std::path::PathBuf::from)
        .map(Ok).unwrap_or_else(std::env::current_dir).map_err(|e| e.to_string())?;
    let output = std::process::Command::new("git").args(["rev-parse", "--show-toplevel"]).current_dir(&cwd).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("Execute ags test dentro de um repositório Git.".into()); }
    let root = dunce::canonicalize(std::path::Path::new(String::from_utf8_lossy(&output.stdout).trim())).map_err(|e|e.to_string())?;
    let suite = args.get("suite").and_then(Value::as_str).unwrap_or("");
    let mut selection = None;
    let commands = if command == "test.run" { test_runner::suite_commands_in(&root, suite)? } else if command == "test.status" { vec![] } else if command == "test.affected" {
        let changed = test_runner::changed_files(&root)?;
        // Fora do layout do ADE-AGS, as suítes detectadas (ver testspeed::project).
        let plan = match ade_ags_lib::testspeed::project::detect(&root) {
            ade_ags_lib::testspeed::project::Layout::AdeAgs => {
                let unsafe_files = test_runner::unsafe_files(&root,&changed)?;
                ade_ags_lib::testspeed::affected::plan_with_unsafe(&changed,&unsafe_files).with_changed_base(&test_runner::base_ref(&root))
            }
            ade_ags_lib::testspeed::project::Layout::Generic(suites) => ade_ags_lib::testspeed::affected::plan_generic(&changed, &suites),
        };
        eprint!("{}", plan.render_dry_run());
        let commands = plan.steps.iter().map(|step| test_runner::TestCommand {
            suite:step.suite.into(),program:step.program.clone(),args:step.args.clone(),cwd:step.cwd.unwrap_or(".").into()
        }).collect();
        selection = Some((changed, plan));
        commands
    } else {
        return Err(format!("Comando desconhecido '{command}'. Use test run <suite> ou test status."));
    };
    if args.get("dryRun").and_then(Value::as_bool).unwrap_or(false) {
        return Ok((json!({"commands":commands,"full":selection.as_ref().is_some_and(|(_,p)|p.full),"risk":selection.as_ref().map(|(_,p)|&p.risk),"unmapped":selection.as_ref().map(|(_,p)|&p.unmapped),"ignored":selection.as_ref().map(|(_,p)|&p.ignored)}), true));
    }
    let home = ade_ags_lib::util::datadir::ags_home().ok_or("Não foi possível localizar a pasta do usuário.")?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let conn = rusqlite::Connection::open(home.join("data.db")).map_err(|e| e.to_string())?;
    // 30 s e não 5: o app grava em WAL ao mesmo tempo, e um "database is locked" aqui jogava
    // fora um verde já obtido (a próxima chamada rodava a suíte de novo).
    conn.execute_batch("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;
    // Additive DDL only: the standalone CLI never migrates or downgrades the app DB.
    test_runner::migrate(&conn).map_err(|e| e.to_string())?;
    if command == "test.status" { return Ok((test_runner::status(&conn,&root)?,true)); }
    let explicit_mission = args.get("mission").and_then(Value::as_str).map(str::to_owned)
        .or_else(||std::env::var("ADE_MISSION_ID").ok());
    let inferred: Option<(String,String)> = conn.query_row(
        "SELECT w.mission_id,w.name FROM mission_team_workspaces w JOIN missions m ON m.id=w.mission_id WHERE w.root=?1 AND m.status='running' LIMIT 1",
        [root.to_string_lossy().as_ref()], |r|Ok((r.get(0)?,r.get(1)?))).optional().unwrap_or(None);
    let mission = explicit_mission.or_else(||inferred.as_ref().map(|r|r.0.clone()));
    let actor = inferred.map(|r|r.1).or_else(||std::env::var("ADE_TAB_ID").ok()).unwrap_or_default();
    let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
    if command == "test.affected" {
        let (_,plan) = selection.as_ref().expect("affected selection");
        let suites: std::collections::BTreeSet<_> = commands.iter().map(|c|c.suite.as_str()).collect();
        let skipped = ["frontend","rust","tsc","babel"].iter().filter(|s| !suites.contains(**s)).count();
        let now = chrono::Utc::now().timestamp_millis();
        test_runner::record_span(&conn,mission.as_deref(),&actor,"affected","",now,now,false,skipped)?;
        // O cargo (o passo lento) corre numa thread própria, com a sua conexão, enquanto babel,
        // tsc e vitest correm aqui em série. Antes era tudo em fila: o tempo do cargo somava ao
        // dos outros. Cada thread para no primeiro passo que falha dela.
        let (rust_steps, quick_steps): (Vec<_>, Vec<_>) = commands.iter().cloned().partition(|step| step.suite == "rust");
        let rust_thread = (!rust_steps.is_empty()).then(|| {
            let (db, root, mission, actor) = (home.join("data.db"), root.clone(), mission.clone(), actor.clone());
            std::thread::spawn(move || -> Result<Vec<test_runner::RunResult>, String> {
                let conn = rusqlite::Connection::open(db).map_err(|e| e.to_string())?;
                conn.execute_batch("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;
                let mut out = Vec::new();
                for step in &rust_steps {
                    let result = test_runner::run(&conn,&root,&step.suite,std::slice::from_ref(step),force,mission.as_deref(),&actor)?;
                    let ok = result.passed;
                    out.push(result);
                    if !ok { break; }
                }
                Ok(out)
            })
        });
        let mut results = Vec::new();
        let mut passed = true;
        for step in &quick_steps {
            let result = test_runner::run(&conn,&root,&step.suite,std::slice::from_ref(step),force,mission.as_deref(),&actor)?;
            passed &= result.passed;
            results.push(result);
            if !passed { break; }
        }
        if let Some(thread) = rust_thread {
            let rust = thread.join().map_err(|_| "o passo de Rust terminou com pânico".to_string())??;
            passed &= rust.iter().all(|result| result.passed);
            results.extend(rust);
        }
        return Ok((json!({"results":results,"passed":passed,"full":plan.full,"risk":plan.risk,"unmapped":plan.unmapped,"ignored":plan.ignored,"skippedAffected":skipped}),passed));
    }
    let result = test_runner::run(&conn,&root,suite,&commands,force,mission.as_deref(),&actor)?;
    Ok((json!(result),result.passed))
}

fn execute_standalone_redeliver(args: &Value) -> ExitCode {
    let home = match ade_ags_lib::util::datadir::ags_home() {
        Some(h) => h,
        None => {
            println!("{}", json!({ "error": "não foi possível determinar o diretório home" }));
            return ExitCode::from(EXIT_COMMAND_FAILED);
        }
    };
    let db_path = home.join("data.db");
    let conn = match rusqlite::Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            println!("{}", json!({ "error": format!("erro ao abrir banco de dados: {e}") }));
            return ExitCode::from(EXIT_COMMAND_FAILED);
        }
    };
    let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");
    if let Err(e) = ade_ags_lib::migrate(&conn) {
        println!("{}", json!({ "error": format!("erro ao migrar banco de dados: {e}") }));
        return ExitCode::from(EXIT_COMMAND_FAILED);
    }

    let mission_id = match args.get("mission").and_then(Value::as_str) {
        Some(id) => id,
        None => {
            println!("{}", json!({ "error": "informe o id da missão" }));
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let pr = args.get("pr").or_else(|| args.get("pullRequest")).and_then(Value::as_str);
    let test_override = match args.get("test") {
        Some(Value::String(s)) => Some(ade_ags_lib::missions::TestResult::parse(s)),
        Some(Value::Bool(true)) => Some(ade_ags_lib::missions::TestResult::Passed),
        Some(Value::Bool(false)) => Some(ade_ags_lib::missions::TestResult::Failed),
        _ => None,
    };

    let cwd = match ade_ags_lib::missions::store::get(&conn, mission_id) {
        Ok(Some(m)) => m.cwd,
        Ok(None) => {
            println!("{}", json!({ "error": format!("missão não encontrada: {mission_id}") }));
            return ExitCode::from(EXIT_COMMAND_FAILED);
        }
        Err(e) => {
            println!("{}", json!({ "error": e }));
            return ExitCode::from(EXIT_COMMAND_FAILED);
        }
    };

    match ade_ags_lib::missions::store::redeliver(&conn, mission_id, &cwd, pr, test_override) {
        Ok(outcome) => {
            println!("{}", json!(outcome));
            ExitCode::from(EXIT_OK)
        }
        Err(e) => {
            println!("{}", json!({ "error": e }));
            ExitCode::from(EXIT_COMMAND_FAILED)
        }
    }
}

struct CliError {
    message: String,
    code: u8,
    /// La app todavía no está alcanzable, pero podría estarlo en un momento: el handshake
    /// no está escrito o el puerto no acepta. Un protocolo distinto o un comando rechazado
    /// no se arreglan esperando, y esos no lo marcan.
    retryable: bool,
}

impl CliError {
    fn new(message: String, code: u8) -> Self {
        CliError { message, code, retryable: false }
    }

    /// Todavía no, pero puede que sí: ver `retryable`.
    fn not_yet(message: String) -> Self {
        CliError { message, code: EXIT_NO_APP, retryable: true }
    }
}

/// Agrega `from` a los comandos `peer.*`, `note.*`, `portal.*`, `notify.*`, `role.*`, `floor.*`, `routine.*`, `say.*` y `recall.*` a partir de `ADE_TAB_ID`, salvo que ya venga.
/// Em `memory.*` e `swarm.*` o `from` e a `session` vêm só do ambiente que o app injetou no PTY.
fn with_caller(command: &str, mut parsed: Value) -> Value {
    const GROUPS: [&str; 13] = ["peer.", "note.", "portal.", "device.", "notify.", "role.", "floor.", "routine.", "say.", "recall.", "memory.", "design.", "swarm."];
    if !GROUPS.iter().any(|g| command.starts_with(g)) {
        return parsed;
    }
    caller_from(
        command,
        &mut parsed,
        std::env::var("ADE_TAB_ID").ok(),
        std::env::var(ade_ags_lib::SESSION_ENV).ok(),
    );
    parsed
}

fn caller_from(command: &str, parsed: &mut Value, tab: Option<String>, session: Option<String>) {
    if command.starts_with("memory.") || command.starts_with("swarm.") {
        if let Some(map) = parsed.as_object_mut() {
            map.remove("from");
            map.remove("mission");
            map.remove("missionId");
            map.remove("taskId");
            map.remove("session");
            if let Some(tab) = tab.filter(|value| !value.is_empty()) {
                map.insert("from".into(), Value::String(tab));
            }
            if let Some(session) = session.filter(|value| !value.is_empty()) {
                map.insert("session".into(), Value::String(session));
            }
        }
        return;
    }
    // The design creator is always the actual terminal, even if an agent passed --from.
    if parsed.get("from").is_some() && !command.starts_with("design.") { return; }
    if let (Some(tab), Some(map)) = (tab, parsed.as_object_mut()) {
        map.insert("from".into(), Value::String(tab));
    }
}

/// Grupos que se escriben solos porque tienen una sola acción útil.
fn shortcut(word: &str) -> Option<&'static str> {
    match word {
        "agents" => Some("agent.list"),
        "accounts" => Some("account.list"),
        "prelaunch" => Some("prelaunch.list"),
        "skills" => Some("skill.list"),
        "peers" => Some("peer.list"),
        "notes" => Some("note.list"),
        "portals" => Some("portal.list"),
        "open" => Some("portal.open"),
        "devices" => Some("device.list"),
        "pools" => Some("pool.list"),
        // `ags notify "terminé"`: avisar es lo único que se hace con eso.
        "notify" => Some("notify.send"),
        "roles" => Some("role.list"),
        "floors" => Some("floor.list"),
        "routines" => Some("routine.list"),
        // `ags say "pronto"`: hablarle al usuario es lo único que se hace con `say`.
        "say" => Some("say.send"),
        "recall" => Some("recall.get"),
        _ => None,
    }
}

/// Design has nested page/artboard commands as well as direct actions.
fn design_defaults(command: &str, mut args: Value, cwd: &std::path::Path) -> Value {
    if command == "design.create" && args.get("workspace").is_none() {
        args["workspace"] = json!(cwd.to_string_lossy());
    }
    if matches!(command, "design.comment" | "design.comment.add") && args.get("author").is_none() {
        args["author"] = json!("agent");
    }
    if command == "design.artboard.add" && args.get("page").is_some() && args.get("designId").is_none() {
        if let Some(id) = args.as_object_mut().and_then(|a| a.remove("pageId")) {
            args["designId"] = id;
        }
    }
    args
}

fn design_command(args: &[String]) -> Result<(String, &[String]), String> {
    let action = args.get(1).ok_or("Missing design action")?;
    let nested = matches!(action.as_str(), "page" | "artboard")
        || (action == "comment" && args.get(2).is_some_and(|v| matches!(v.as_str(), "add" | "resolve")))
        || (action == "approve" && args.get(2).is_some_and(|v| v == "all"));
    if nested {
        let sub = args.get(2).ok_or("Missing design subcommand")?;
        Ok((format!("design.{action}.{sub}"), &args[3..]))
    } else {
        Ok((format!("design.{action}"), &args[2..]))
    }
}
/// Argumentos que se pueden escribir sueltos, en orden, sin su flag.
///
/// `ags skill install git-helper` en vez de `--skill git-helper`. Solo se declara acá lo
/// que tiene un argumento obvio y único: si hubiera dudas sobre a qué flag corresponde un
/// valor suelto, es mejor exigir el flag que adivinar mal.
/// Valida o uso antes do IPC, inclusive argumentos passados por --json-args.
fn validate_usage(command: &str, args: &Value) -> Result<(), String> {
    if command == "peer.check" && args.get("to").and_then(Value::as_str).is_none_or(|to| to.trim().is_empty()) {
        return Err("Uso: ags peer check <nome> [--lines 60]".into());
    }
    if command.starts_with("run.") {
        for (key, flag) in [("runId", "run-id"), ("run_id", "run-id"), ("task", "task")] {
            if let Some(value) = args.get(key) {
                if value.as_str().is_none_or(|value| value.trim().is_empty()) {
                    return Err(format!("--{flag} precisa de um valor"));
                }
            }
        }
    }
    Ok(())
}

/// A pasta vem da shell do CLI, nunca da pasta em que o app foi iniciado.
fn run_defaults(mut args: Value, shell_cwd: &std::path::Path) -> Result<Value, String> {
    let requested = match args.get("cwd") {
        Some(value) => value.as_str().filter(|value| !value.trim().is_empty())
            .ok_or("--cwd precisa de um caminho")?,
        None => ".",
    };
    let path = std::path::absolute(shell_cwd.join(requested))
        .map_err(|error| format!("Não foi possível resolver --cwd: {error}"))?;
    args["cwd"] = Value::String(path.to_string_lossy().into_owned());
    Ok(args)
}

fn positionals(command: &str) -> &'static [&'static str] {
    match command {
        "gemini.result" => &["id"],
        "test.run" => &["suite"],
        "design.create" => &["title"],
        "design.get" | "design.delete" | "design.archive" | "design.approve.all" => &["designId"],
        "design.page.add" => &["designId", "name"],
        "design.artboard.add" => &["pageId", "title"],
        "design.update" | "design.artboard.update" | "design.revert" | "design.artboard.revert" | "design.approve" | "design.artboard.approve" | "design.reject" | "design.artboard.reject" => &["artboardId"],
        "design.comment" | "design.comment.add" => &["artboardId", "text"],
        "design.comment.resolve" => &["commentId"],
        "skill.install" => &["skill"],
        "skill.show" | "skill.edit" => &["skill"],
        // `ags skill new mi-skill` en vez de `--name mi-skill`.
        "skill.new" => &["name"],
        // `ags skill search react` en vez de `--query react`.
        "skill.search" => &["query"],
        // El texto va segundo: `ags tab send <id> "corré los tests"`.
        "tab.send" => &["tab", "text"],
        "tab.output" | "tab.close" | "tab.state" | "watch.add" | "watch.remove" => &["tab"],
        "tab.create" => &["cwd"],
        "workspace.open" => &["workspace"],
        // `ags mission wait <id>`, `ags mission accept <id> <tarea>`.
        "mission.start" | "mission.status" | "mission.wait" | "mission.review" | "mission.apply" | "mission.timings" | "mission.efficiency" | "mission.precheck" | "mission.startcheck" | "mission.redeliver" => &["mission"],
        "mission.cleanup" => &["mission"],
        "mission.accept" => &["mission", "task"],
        "approval.decide" => &["approval"],
        // `ags peer ask Revisor "..."`: el nombre del agente y después el mensaje.
        "peer.ask" | "peer.tell" => &["to", "text"],
        "fix.list" => &["scope"],
        "fix.decide" => &["scope", "work", "action"],
        "peer.check" => &["to"],
        "peer.recruit" => &["name"],
        "peer.connect" | "peer.disconnect" => &["a", "b"],
        "peer.role" => &["to", "role"],
        "ci.watch" => &["pr"],
        // `ags peer deliver --file entrega.json` (ao orquestrador) ou `ags peer deliver QA --file ...`.
        "peer.deliver" => &["to", "text"],
        "peer.handoff" => &["id"],
        // `ags peer queue`, `ags peer queue cancel 12`.
        "peer.queue" => &["action", "id"],
        // `ags peer answer 12 1`: a pendência e a resposta.
        "peer.answer" => &["id", "text"],
        // `ags note read Plano 10 20`: desde la línea 10, 20 líneas.
        "notify.send" => &["message"],
        // `ags role create "Revisor" "Procure falhas..."`; el texto también va con --file.
        "floor.create" => &["name"],
        "say.send" => &["text"],
        "recall.get" => &["thread"],
        "memory.search" => &["query"],
        "memory.open" => &["path"],
        "swarm.note" | "swarm.question" => &["body"],
        "swarm.promote" => &["note", "key"],
        "memory.compact" => &["retentionDays"],
        "workspace.restore" => &["workspace"],
        // `ags routine create Testes "rode os testes" --at 09:00`
        "routine.create" => &["name", "text"],
        "routine.edit" => &["name", "text"],
        "routine.show" | "routine.enable" | "routine.disable" | "routine.run" | "routine.delete" => &["name"],
        "role.show" => &["role"],
        "role.create" => &["name", "content"],
        "role.edit" => &["role", "content"],
        "note.create" => &["content"],
        "note.read" => &["name", "start", "count"],
        "note.write" => &["name", "content"],
        "note.edit" => &["name", "old", "new"],
        // `ags portal click Web @e3`: el portal primero, después lo que cada acción pide.
        "portal.create" => &["name", "url"],
        "portal.open" => &["url"],
        "portal.close" => &["name"],
        "portal.act" => &["name", "goal"],
        "portal.navigate" => &["name", "url"],
        "portal.history" => &["name", "action"],
        "portal.click" | "portal.hover" => &["name", "target"],
        "portal.type" => &["name", "target", "text"],
        "portal.press" => &["name", "key"],
        "portal.select" => &["name", "target", "value"],
        // `ags device tap Pixel --text Entrar`: el dispositivo primero, y lo que cada acción pide.
        "pool.create" | "pool.delete" => &["name"],
        "device.create" => &["name"],
        "device.start" | "device.shot" | "device.tree" => &["name"],
        "device.type" => &["name", "text"],
        "device.key" => &["name", "key"],
        "device.launch" | "device.close" => &["name", "package"],
        "device.open" => &["name", "url"],
        "device.button" => &["name", "button"],
        "device.say" => &["name", "text"],
        "device.tap" | "device.swipe" => &["name"],
        "portal.scroll" | "portal.wait" | "portal.snapshot" | "portal.screenshot" | "portal.console"
        | "portal.layout" | "portal.reset" => &["name"],
        _ => &[],
    }
}

/// `--flag valor` y `--flag` (booleano). Las claves se pasan a camelCase para que el
/// backend reciba los mismos nombres que usa el resto de la app (`--close-current` →
/// `closeCurrent`). `--skills a,b` se parte en array, que es lo que espera el frontend.
fn parse_flags(args: &[String], positionals: &[&str]) -> Result<Value, String> {
    let mut map = Map::new();
    let mut i = 0;

    // Valores sueltos al principio: `ags skill install git-helper`. Solo al principio —
    // después de que aparece el primer `--flag`, una palabra suelta es casi siempre un
    // error de tipeo, y tragársela en silencio sería peor que rechazarla.
    let mut next = 0;
    while i < args.len() && !args[i].starts_with("--") {
        let Some(key) = positionals.get(next) else {
            return Err(format!(
                "Argumento inesperado '{}'. Este comando {}",
                args[i],
                if positionals.is_empty() {
                    "só aceita flags (começam com --)".to_string()
                } else {
                    format!("aceita no máximo {} valor(es) solto(s): {}", positionals.len(), positionals.join(", "))
                }
            ));
        };
        map.insert(key.to_string(), value_for(key, &args[i]));
        next += 1;
        i += 1;
    }

    while i < args.len() {
        let raw = &args[i];
        let Some(key) = raw.strip_prefix("--") else {
            return Err(format!("Argumento inesperado '{raw}' (as flags começam com --)"));
        };

        // Escotilla para lo que el parseo simple no cubra (objetos anidados, etc.).
        if key == "json-args" {
            let value = args.get(i + 1).ok_or("--json-args precisa de um valor")?;
            let extra: Value = serde_json::from_str(value)
                .map_err(|e| format!("--json-args não é um JSON válido: {e}"))?;
            if let Value::Object(obj) = extra {
                map.extend(obj);
            } else {
                return Err("--json-args precisa ser um objeto JSON".to_string());
            }
            i += 2;
            continue;
        }

        // `--pre` y `--pre-preset` son repetibles, sin tope, y comparten UNA lista: el
        // orden entre ellos es semántico (`nvm use` antes de lo que dependa de npm), así
        // que acumularlos en arrays separados perdería justamente eso.
        //
        // `--pre` acepta las dos cosas — el nombre de un guardado o un comando escrito a
        // mano — y se resuelve del lado de la app, que es donde están los guardados: si el
        // texto coincide con el nombre de uno, se usa ese; si no, se ejecuta tal cual.
        // `--pre-preset` es la forma explícita, para cuando un guardado se llama igual que
        // un comando que querés correr literal.
        if key == "pre" || key == "pre-preset" {
            let value = args
                .get(i + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| format!("--{key} precisa de um valor"))?;
            let step = if key == "pre" {
                json!({ "pre": value })
            } else {
                json!({ "presetName": value })
            };
            match map.entry("prelaunch".to_string()) {
                serde_json::map::Entry::Occupied(mut e) => {
                    if let Some(list) = e.get_mut().as_array_mut() {
                        list.push(step);
                    }
                }
                serde_json::map::Entry::Vacant(e) => {
                    e.insert(Value::Array(vec![step]));
                }
            }
            i += 2;
            continue;
        }

        // `--fill campo=valor` repete (um por campo do formulário): acumula numa lista, como `--pre`.
        // `--expect tipo:valor` também (text:, url:, count:, absent:): o que prova o sucesso do `act`.
        if key == "fill" || key == "expect" {
            let value = args
                .get(i + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| if key == "fill" { "--fill precisa de campo=valor".to_string() } else { "--expect precisa de tipo:valor (text:, url:, count: ou absent:)".to_string() })?;
            match map.entry(key.to_string()) {
                serde_json::map::Entry::Occupied(mut e) => {
                    if let Some(list) = e.get_mut().as_array_mut() {
                        list.push(json!(value));
                    }
                }
                serde_json::map::Entry::Vacant(e) => {
                    e.insert(Value::Array(vec![json!(value)]));
                }
            }
            i += 2;
            continue;
        }

        if matches!(key, "run-id" | "task")
            && args.get(i + 1).is_none_or(|value| value.starts_with("--") || value.trim().is_empty())
        {
            return Err(format!("--{key} precisa de um valor"));
        }

        let camel = to_camel_case(key);
        match args.get(i + 1) {
            // El siguiente token es otro flag (o no hay ninguno) → este es booleano.
            Some(next) if !next.starts_with("--") => {
                map.insert(camel.clone(), value_for(&camel, next));
                i += 2;
            }
            _ => {
                map.insert(camel, Value::Bool(true));
                i += 1;
            }
        }
    }

    Ok(Value::Object(map))
}

/// Reemplaza `--file <ruta>` por el contenido del archivo, en el campo que el comando usa para
/// su texto principal (ver `text_field`).
///
/// Los dos no se pueden combinar: si vinieran juntos habría que elegir cuál gana, y
/// cualquier elección sería una sorpresa para quien mandó el otro.
fn inline_file(args: Value, command: &str) -> Result<Value, String> {
    let Value::Object(mut map) = args else { return Ok(args) };
    let Some(file) = map.remove("file") else { return Ok(Value::Object(map)) };
    let Some(path) = file.as_str() else {
        return Err("--file precisa de um caminho".to_string());
    };
    let field = text_field(command);
    if map.contains_key(field) {
        return Err(format!("Use --file ou --{field}, não os dois"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Não foi possível ler {path}: {e}"))?;
    let content = decode_text_file(&bytes).map_err(|e| format!("Não foi possível ler {path}: {e}"))?;
    map.insert(field.to_string(), Value::String(content));
    Ok(Value::Object(map))
}

/// O texto de um arquivo, sem a marca de ordem de bytes (BOM). O PowerShell 5 grava `utf8` com BOM e
/// `Out-File` em UTF-16: o BOM chegava ao agente como um caractere invisível, e o Claude Code parava
/// em "Removed 1 invisible character · review and press Enter to send" sem enviar a mensagem. Pura.
fn decode_text_file(bytes: &[u8]) -> Result<String, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec()).map_err(|e| e.to_string());
    }
    let utf16 = |rest: &[u8], big: bool| -> Result<String, String> {
        let units: Vec<u16> = rest.chunks_exact(2).map(|p| if big { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) }).collect();
        String::from_utf16(&units).map_err(|e| e.to_string())
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, true);
    }
    String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
}

/// El campo que `--file` llena: el texto del comando (`text`, como `peer tell`, `tab send` o
/// `say`), el `body` de swarm, o `content` (notas, roles, diseños). Pura.
///
/// `peer tell` antes mandaba el archivo como `content` y el backend lo rechazaba: por eso el
/// nombre sale de los argumentos sueltos del comando y no de una lista fija.
fn text_field(command: &str) -> &'static str {
    let positional = positionals(command);
    if positional.contains(&"text") {
        "text"
    } else if positional.contains(&"body") {
        "body"
    } else {
        "content"
    }
}

fn value_for(key: &str, raw: &str) -> Value {
    match key {
        "priority" => raw.parse::<i64>().map(Value::from).unwrap_or_else(|_| Value::String(raw.into())),
        // Mismo trato que `--skills`: listas cortas separadas por coma.
        "skills" | "categories" | "agents" => Value::Array(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| Value::String(s.to_string()))
                .collect(),
        ),
        // Un número mal escrito se manda tal cual como string: el backend lo rechaza con
        // un mensaje que nombra el flag, mejor que un "0" silencioso acá.
        "lines" | "timeout" | "max" | "idle" | "start" | "count" | "turns" | "limit" | "maxParallel" => {
            raw.parse::<u64>().map(Value::from).unwrap_or_else(|_| Value::String(raw.into()))
        }
        _ => Value::String(raw.to_string()),
    }
}

/// Cuánto esperar la respuesta de la app.
///
/// Casi todos los comandos responden al instante. Tres no:
/// - `watch wait` bloquea a propósito hasta su timeout, así que la CLI tiene que esperar
///   más que él o cortaría justo la llamada cuya gracia es quedarse esperando.
/// - `tab create --initprompt` espera a que la TUI termine de arrancar antes de escribirle,
///   y eso puede llevarse varias decenas de segundos con un agente lento.
/// - `run.approve` espera a que una PERSONA mire un diff y decida. Ahí el tope no lo pone
///   la paciencia de la CLI sino la del broker, así que se le suma margen al suyo.
fn read_timeout_for(command: &str, args: &Value) -> Duration {
    const DEFAULT: u64 = 30;
    match command {
        "watch.wait" => {
            let requested = args.get("timeout").and_then(Value::as_u64).unwrap_or(300);
            Duration::from_secs(requested + 15)
        }
        // Igual: bloquea hasta que llega un evento o vence su plazo (tope 600 s).
        "events.wait" => {
            let requested = args.get("timeout").and_then(Value::as_u64).unwrap_or(60).clamp(1, 600);
            Duration::from_secs(requested + 15)
        }
        // Esperar una misión entera: lo que se pidió (una hora por defecto, tope 6 h), más
        // el arranque, que puede sondear el roster.
        "mission.wait" | "mission.run" => {
            let requested = args.get("timeout").and_then(Value::as_u64).unwrap_or(3600).clamp(1, 6 * 3600);
            Duration::from_secs(requested + 180)
        }
        // Arrancar rutea el lead (puede sondear el roster); integrar y aplicar hacen merges.
        "mission.start" | "mission.accept" | "mission.apply" | "mission.review" | "mission.redeliver" => Duration::from_secs(180),
        // Los topes del backend suman ~40s (15 para que aparezca el PTY + 25 de arranque).
        "tab.create" if has_init_prompt(args) => Duration::from_secs(75),
        // `pick` espera a una persona; el resto son segundos.
        "browser.run" if args.pointer("/request/op").and_then(Value::as_str) == Some("pick") => {
            let asked = args.pointer("/request/timeout_s").and_then(Value::as_u64).unwrap_or(120).clamp(10, 600);
            Duration::from_secs(asked + 60)
        }
        "browser.run" => Duration::from_secs(ade_ags_lib::ipc::mcp::BROWSER_TIMEOUT_SECS + 15),
        // Esperar a que terminen workers: lo que pidió el agente, más margen.
        "run.await" => {
            let requested = args.pointer("/args/timeout_s").and_then(Value::as_u64).unwrap_or(300).clamp(10, 1800);
            Duration::from_secs(requested + 30)
        }
        // `peer ask` espera el turno entero del otro agente; antes de escribirle espera hasta
        // 60s a que se calle (no se interrumpe a quien está trabajando).
        "peer.ask" => {
            let requested = args.get("timeout").and_then(Value::as_u64).unwrap_or(600).clamp(10, 3600);
            Duration::from_secs(requested + 90)
        }
        "peer.tell" => Duration::from_secs(90),
        "fix.list" | "fix.decide" => Duration::from_secs(60),
        // Cargar una página o esperar un texto puede tardar; el backend corta a los 90 s.
        c if c.starts_with("portal.") => Duration::from_secs(120),
        // Arrancar un emulador y esperar a que termine de iniciar (el backend corta a los 120 s).
        "device.start" => Duration::from_secs(150),
        c if c.starts_with("device.") => Duration::from_secs(60),
        // `routine run` espera a que el agente de destino se calle (hasta 60 s).
        "routine.run" => Duration::from_secs(120),
        // Abrir la tab, esperar su PTY (15s) y que arranque (25s) antes de darle la tarea.
        "peer.recruit" => Duration::from_secs(120),
        // Validar un plan puede sondear el roster (lanzar `opencode models`) y crear worktrees.
        "run.plan" | "run.addTask" | "run.roster" => Duration::from_secs(120),
        "run.approve" => {
            let requested = args
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(ade_ags_lib::ipc::mcp::APPROVAL_TIMEOUT_SECS);
            Duration::from_secs(requested + 30)
        }
        _ => Duration::from_secs(DEFAULT),
    }
}

fn has_init_prompt(args: &Value) -> bool {
    ["initPrompt", "initprompt"].iter().any(|k| args.get(k).and_then(Value::as_str).is_some())
}

fn to_camel_case(flag: &str) -> String {
    let mut out = String::with_capacity(flag.len());
    let mut upper_next = false;
    for c in flag.chars() {
        if c == '-' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Cuánto espera el puente MCP a que la app esté alcanzable antes de darse por vencido.
///
/// Existe por el arranque: la app restaura sus ventanas —que lanzan a los agentes— y recién
/// después abre el servidor de la CLI. Un agente que llama a una herramienta en ese hueco
/// recibía "ADE AGS no parece estar corriendo", y Claude Code da por caído al servidor
/// entero por esa respuesta. También cubre el reinicio de la app con tareas en curso.
///
/// Solo para `ags mcp`. Una persona que escribe `ags tab list` con la app cerrada tiene
/// que enterarse en el momento, no diez segundos después.
const MCP_WAIT_FOR_APP: Duration = Duration::from_secs(15);

/// Como `send`, pero esperando a que la app aparezca en vez de fallar en el primer intento.
fn send_waiting(command: &str, args: Value) -> Result<Response, CliError> {
    let deadline = Instant::now() + MCP_WAIT_FOR_APP;
    let mut pause = Duration::from_millis(100);
    loop {
        match send(command, args.clone()) {
            Err(e) if e.retryable && Instant::now() < deadline => {
                std::thread::sleep(pause);
                // Creciente: el hueco del arranque dura poco, y si la app de verdad no está
                // no tiene sentido golpear el disco veinte veces por segundo.
                pause = (pause * 2).min(Duration::from_secs(1));
            }
            other => return other,
        }
    }
}

fn send(command: &str, args: Value) -> Result<Response, CliError> {
    let path = client_handshake_path();
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        CliError::not_yet(format!(
            "O ADE AGS não parece estar em execução (não encontrei {}). Abra o app e tente de novo.",
            path.display()
        ))
    })?;

    // Reintentable: la app lo reescribe sola si quedó mal (ver `ipc::server::watch_handshakes`).
    let handshake: Handshake = serde_json::from_str(&raw)
        .map_err(|e| CliError::not_yet(format!("O arquivo de handshake {} está corrompido ({e}); reinicie o app", path.display())))?;

    if handshake.protocol != PROTOCOL_VERSION {
        // A propósito NO es reintentable: esperar no cambia la versión de nadie.
        return Err(CliError::new(
            format!(
                "O app fala o protocolo v{} e este CLI, o v{PROTOCOL_VERSION}. Atualize o que ficou antigo.",
                handshake.protocol
            ),
            EXIT_NO_APP,
        ));
    }

    let timeout = read_timeout_for(command, &args);
    let request = Request { token: handshake.token.clone(), command: command.to_string(), args };
    let payload = serde_json::to_string(&request).map_err(|e| CliError::new(e.to_string(), EXIT_USAGE))?;
    let line = ade_ags_lib::ipc::exchange(&handshake, &payload, timeout).map_err(|e| {
        if e.retryable { CliError::not_yet(e.message) } else { CliError::new(e.message, EXIT_NO_APP) }
    })?;

    serde_json::from_str(&line).map_err(|e| CliError::new(format!("Resposta ilegível do app: {e}"), EXIT_NO_APP))
}

/// `ags mcp`: el puente MCP de un agente. Con `--task` es el de una tarea de la flota
/// (permisos y navegador); con `--cwd`, el de una tab de Claude Code (solo el navegador).
///
/// Cada pedido se traduce a un comando del mismo protocolo que usa el resto de la CLI, así
/// que no hay un canal nuevo ni una autorización nueva — el token del handshake es el
/// mismo. Los errores van a stderr: stdout es del JSON-RPC y meterle una línea suelta
/// rompe al cliente.
fn parse_mcp_args(args: &[String]) -> Result<(ade_ags_lib::ipc::mcp::McpContext, String), String> {
    use ade_ags_lib::ipc::mcp::McpContext;

    // Por nombre y no por posición: OpenCode escribe el comando entero en un arreglo de su
    // config, y no hay razón para que el orden en que lo escriba alguien a mano tenga que
    // coincidir con el que escribe la app.
    let mut flags: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            name @ ("--task" | "--cwd" | "--tab" | "--mission" | "--role" | "--prefix") => {
                let Some(value) = rest.next() else {
                    return Err(format!("Falta o valor de {name}"));
                };
                flags.insert(name, value.clone());
            }
            other => {
                return Err(format!("Argumento inesperado para 'ags mcp': {other}"));
            }
        }
    }

    let context = match (flags.remove("--task"), flags.remove("--cwd")) {
        (Some(task), _) => McpContext::Task(task),
        (None, Some(cwd)) => McpContext::Cwd {
            cwd,
            tab: flags.remove("--tab"),
            mission: flags.remove("--mission"),
            role: flags.remove("--role"),
        },
        (None, None) => {
            return Err("Uso: ags mcp --task <id-da-tarefa> | --cwd <pasta> [--tab <id-da-tab>] [--mission <id>] [--role <papel>] [--prefix <prefixo>]".into());
        }
    };
    // Lo que esta TUI le antepone al nombre de cada tool. Vacío = no antepone nada.
    let prefix = flags.remove("--prefix").unwrap_or_default();
    Ok((context, prefix))
}

fn run_mcp(args: &[String]) -> ExitCode {
    let (context, prefix) = match parse_mcp_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    let stdin = std::io::stdin();
    let result = ade_ags_lib::ipc::mcp::serve(
        &context,
        &prefix,
        stdin.lock(),
        std::io::stdout(),
        |command, payload| {
            let response = send_waiting(command, payload).map_err(|e| e.message)?;
            if response.ok {
                Ok(response.data.unwrap_or(Value::Null))
            } else {
                Err(response.error.unwrap_or_else(|| "o app recusou o pedido".into()))
            }
        },
    );

    match result {
        Ok(()) => ExitCode::from(EXIT_OK),
        Err(e) => {
            eprintln!("ags mcp: {e}");
            ExitCode::from(EXIT_COMMAND_FAILED)
        }
    }
}

// El archivo vive fuera de `src/bin/` a propósito: el bundler de Tauri trata CADA entrada
// de ese directorio como un ejecutable a empaquetar, así que una carpeta `cli/` al lado de
// `cli.rs` le hacía buscar un binario `cli` que no existe y abortaba el empaquetado.
#[path = "../cli_smoke.rs"]
mod smoke;

#[cfg(test)]
#[path = "../cli_test.rs"]
mod test;
