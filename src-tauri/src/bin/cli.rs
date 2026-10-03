//! CLI `controlcode` — Fase 8.
//!
//! Habla con la instancia de la app que esté corriendo (ver `ipc::protocol`). Toda la
//! salida va a stdout como JSON en una línea, para que un agente la parsee sin heurísticas;
//! los mensajes para humanos (ayuda, errores de uso) van a stderr.
//!
//! El código de salida distingue los casos que a un agente le importan: 0 todo bien,
//! 1 la app rechazó el comando, 2 error de uso, 3 la app no está corriendo.

use controlcode_lib::ipc::protocol::{client_handshake_path, Handshake, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::ExitCode;
use std::time::{Duration, Instant};

const EXIT_OK: u8 = 0;
const EXIT_COMMAND_FAILED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_NO_APP: u8 = 3;

const USAGE: &str = "\
ccode — controla la app Control Code desde la terminal

USO
  ccode <grupo> <acción> [valor] [--flag valor ...]

  El primer valor puede ir suelto, sin su flag:
    ccode skill install git-helper       =  ccode skill install --skill git-helper
    ccode tab send <id> \"corré los tests\" =  ccode tab send --tab <id> --text \"...\"

TABS
  tab list                                    Tabs abiertas ahora
  tab create <ruta> --agent <id>              Abre una tab nueva
             [--skills a,b]                   · skills a adjuntar, por nombre
             [--account <nombre>]             · cuenta de esa TUI (ver `accounts`)
             [--pre <comando|guardado>]       · a ejecutar ANTES del agente; repetible
             [--pre-preset <nombre>]          · fuerza que sea un guardado, no un comando
             [--initprompt \"...\"]             · prompt inicial, enviado con Enter
             [--window <label>]                 cuando la TUI terminó de arrancar
  tab close <id>                              Cierra una tab
  tab output <id> [--lines 40]                Lo NUEVO desde la lectura anterior,
             [--full] [--raw]                 comprimido (errores, warnings, cola)
  tab send <id> \"...\" [--no-enter]            Escribe en su terminal (+ Enter) —
                                              así se sigue la conversación con
                                              una tab que ya está abierta

AGENTES CONECTADOS (canvas) — solo alcanza a los conectados con esta terminal
  peers                                       Quién está conectado con vos
  peer ask <nombre> \"...\" [--timeout 600]    Le pregunta y ESPERA su respuesta
  peer tell <nombre> \"...\"                    Le avisa algo, sin esperar
             (ask/tell --raw: el texto tal cual, sin el encabezado \"[Mensagem de ...]\"; para
              mandarle a una TUI un comando suyo, p. ej. /compact o /clear)
  peer ask --batch '{\"A\":\"...\",\"B\":\"...\"}'  Le pregunta a varios A LA VEZ y espera a todos
  peer check <nombre> [--lines 60]            Lo que se ve ahora en su terminal
  notify \"mensaje\"                            Avisa al usuario (aviso en pantalla; barra de tareas)
  Solo orquestadores (corona en el canvas):
  peer recruit <nombre> --agent <id>          Abre un agente nuevo, ya conectado
              [--prompt \"...\"] [--account <n>]  · con su primera tarea
              [--role <papel>]                  · con un papel (ver roles)
              [--floor <piso>]                  · en ese piso (o `ground`, la planta baja)
  peer connect <a> <b>                        Conecta dos agentes del equipo
  peer disconnect <a> <b>                     Los desconecta

POOLS DE CUENTAS — repartir entre varias cuentas de una TUI con una estrategia
  pools                                       Los pools creados, con sus cuentas y su estrategia
  pool create <nombre> --agent <id> --accounts principal,trabajo [--strategy least-used|round-robin|sticky]
  pool delete <nombre>
  Se piden donde iría una cuenta: tab create --agent claude-code --account pool:Trabajo, o el
  \"account\" de una tarea de un plan / de un miembro de un Squad (pool:Trabajo).

DISPOSITIVOS ANDROID DEL CANVAS — un emulador o teléfono conectado con esta terminal (por adb)
  devices                                     Los que manejás, lo que adb ve y los emuladores (AVD)
  device create [<nombre>] [--avd <avd>]      Crea uno a tu lado, ya conectado
  device start <dispositivo> [--avd <avd>]    Arranca su emulador y espera a que termine de iniciar
  device tap <dispositivo> --x N --y N        Toca · o --text \"Entrar\" (busca el elemento en pantalla)
  device swipe <dispositivo> --dir up|down|left|right   · o --x1 --y1 --x2 --y2 [--ms 300]
  device type <dispositivo> \"texto\"          Escribe (solo ASCII) · device key <d> back|home|enter|...
  device launch <dispositivo> <paquete>       Abre una app (com.android.settings)
  device shot|tree <dispositivo>              Captura (devuelve la ruta del PNG) · elementos con su texto y dónde tocar

PORTALES DEL CANVAS — navegadores conectados con esta terminal (orquestador: los del equipo)
  portals                                     Los portales que manejás
  portal create [<nombre>] [<url>]            Crea uno a tu lado, ya conectado
  portal navigate <portal> <url>              Va a una URL
  portal snapshot <portal> [--full]           El árbol de la página, con refs (@e3)
  portal click|hover <portal> <@ref|selector>
  portal type <portal> <@ref> \"texto\" [--clear] [--submit]
  portal press <portal> <tecla> [--target <ref>]   · scroll · select · wait · history
  portal screenshot|console|layout <portal>   Foto, consola y medidas
                                              (sin eval, upload ni cookies: eso es del usuario)

CHAT CON EL USUARIO — su chat por hilos (siete colores); lo que escribís en la terminal NO le llega
  say \"texto\" [--progress] [--thread <color>]  Le contestás en el chat (--progress: aviso, tu turno sigue)
      [--file <ruta>]                         · el texto desde un archivo
  recall [<color>|list] [--turns 10 | --all]  Lo que se habló en un hilo (list: los hilos con actividad)

ROTINAS — mensajes a la hora, a vos, a un agente que alcanzás o al usuario
  routines                                    Las tuyas (en un shell: todas)
  routine create <nombre> \"texto\" <cuándo>   · --every 30m | --at 09:00 [--days seg,qua] | --in 45m
              [--to <agente>] [--remind]      · a quién: vos (default), otro agente, o --remind al usuario
              [--catch-up]                    · si la app estaba cerrada a la hora, corre UNA vez al abrir (diaria/única, hasta 24 h)
  routine show|run|enable|disable|delete <nombre>
  routine edit <nombre> [\"texto\"] [--rename <n>] [<cuándo>] [--catch-up|--no-catch-up]
                                              (mínimo 5 min; las de intervalo no recuperan lo perdido con la app cerrada)

PISOS — copias aisladas del proyecto (worktree + rama + canvas propio)
  floors                                      Los pisos de este proyecto y en cuál estás
  floor create <nombre> [--from <rama>]       Solo orquestadores; parte de HEAD o de esa rama
                                              (borrarlos queda en manos del usuario)

PAPELES (para recrutar con --role)
  roles                                       Los papeles: catálogo + los del usuario
  role show <papel>                           Sus instrucciones
  role create <nombre> \"instrucciones\"        Solo orquestadores; también --file <ruta>
  role edit <papel> \"instrucciones\" [--name]  Solo orquestadores; el catálogo no se edita

NOTAS DEL CANVAS — las conectadas con esta terminal (orquestador: las del equipo)
  notes                                       Las notas que alcanzás
  note create [\"texto\"] [--name <n>]          Crea una nota a tu lado, ya conectada
              [--stack <nota>]                · en vez de al lado: dentro de la pila de esa nota (comparten lugar)
              [--file <ruta>]                 · el contenido desde un archivo
  note read <nota> [desde] [cantidad]         La lee con números de línea
  note write <nota> \"texto\" [--file <ruta>]   Reemplaza todo el contenido
  note edit <nota> \"viejo\" \"nuevo\"           Cambia un trecho que aparece UNA vez

OBSERVAR TABS (modo push — evita el polling)
  watch add <id> [--idle 20]                  Empieza a observar una tab
  watch remove <id>                           Deja de observarla
  watch list                                  Tabs observadas y el límite vigente
  watch wait [--timeout 300] [--max 20]       Espera a que alguna tenga novedades

EVENTOS (el bus de la flota y las misiones)
  events since [--after <seq>] [filtros]      Lo que pasó después de ese número
  events wait --after <seq> [--timeout 60] [filtros]
                                              Espera al próximo evento (sin polling)
  Filtros: --topics task.,mission. --run <id> --mission <id> --task <id> --limit 100

MISIONES (también sin interfaz: `controlcode --headless`)
  mission run --objective \"...\" --cwd . [--wait] [--timeout 3600]
              [--title ...] [--agent claude-code] [--model ...] [--account <id>]
              [--squad <id>] [--budget 5] [--max-parallel 2]
                                              Crea, arranca y espera; sale con 1 si falla
  mission create|start|status|wait <id>       Paso a paso (wait: --timeout)
  mission review <id>                         Lo que entregó cada tarea aislada
  mission accept <id> <tarea>                 La junta en la integración de la misión
  mission apply <id>                          Lleva lo aceptado al proyecto
  approval list                               Pedidos de permiso esperando
  approval decide <id> --allow|--deny [--remember]

VENTANAS
  window list                                 Ventanas abiertas
  window create                               Abre una ventana nueva

WORKSPACES
  workspace list                              Workspaces guardados
  workspace open <id|nombre>                  Abre uno
                 [--close-current]
  workspace status                            Qué hay abierto ahora

FLOTA (agentes headless, los de la consola)
  run roster                                  Qué agentes, modelos y cuentas pueden
                                              correr ahora, con costo y cupo
  run status [--cwd <ruta>] [--run-id <id>]   El tablero del run: cada tarea con su
                                              estado, modelo, costo y de qué depende
  run result --task <key|id> [--run-id <id>]  Todo lo que entregó una tarea
  run await [--timeout-s 300]                 Bloquea hasta que una tarea cierre
  run facts [--run-id <id>]                   Lo que los agentes se dejaron escrito
  run add-fact --kind decision --body \"...\"   Comparte un dato con todo el run
  run cancel-task --task <key|id>             Para una, o saca de la cola una que espera
  run reroute-task --task <key|id>            Se la pasa a otro agente, con lo que el
                  [--agent <id>] [--model <m>] anterior ya hizo; misma rama y worktree
  run plan --json-args '{\"objective\":\"...\",  Declara el DAG entero de una vez
           \"tasks\":[{...}]}'                  (más cómodo desde un agente: run_plan)

  Sin --cwd ni --run-id actúa sobre el último run lanzado desde la carpeta
  donde corrés el comando.

MEMORIA COMPARTIDA (la usan los agentes por MCP; ver docs/ade-ags/SHARED_MEMORY.md)
  memory list|get|propose|update|delete|promote-fact --json-args '{...}'
                                              Lo aprobado del workspace y de la misión;
                                              lo que se propone espera aprobación.

NAVEGADOR
  browser run --json-args '{\"cwd\":\"...\",     Una orden al navegador de un proyecto:
              \"request\":{\"op\":\"snapshot\"}}'   snapshot, click, type, resize, console…
                                              Es el mismo camino que usan las 26
                                              herramientas browser_* del MCP.

AGENTES, CUENTAS Y SKILLS
  agents                                      Qué poner en --agent (incluye las custom)
  accounts                                    Qué poner en --account, por TUI
  prelaunch [list]                            Qué poner en --pre
  skills                                      Qué poner en --skills (instaladas)
  skill search <texto>                        Busca en TODOS los repos, skills.sh incluido
                                              (skills.sh se consulta por internet)
  skill install <nombre>                      Instala desde los repos habilitados
  skill show <nombre|id>                      Metadata + contenido del SKILL.md
  skill new <nombre>                          Crea una skill propia (origen local)
             [--description ...] [--categories a,b] [--agents a,b]
             [--file <ruta> | --content \"...\"]
  skill edit <nombre|id>                      Guarda contenido nuevo
             [--file <ruta> | --content \"...\"] [--name <nuevo>] [--copy]

SERVIDOR MCP (no lo escribís vos: lo lanza la app)
  mcp --cwd <carpeta> [--tab <id>]            El puente de una tab interactiva
  mcp --task <id-de-tarea>                    El de una tarea de la flota

  A diferencia del resto, esto NO devuelve una línea JSON: se queda tomado de stdin
  y stdout hablando JSON-RPC con el agente que lo lanzó. Es el servidor `controlcode`
  que le da sus herramientas: el navegador del proyecto, la orquestación de la flota,
  la cuenta de git del usuario (PRs, issues, push/pull), preguntarle algo al usuario,
  y —solo con --task— el permiso de cada acción.

  La app se lo agrega sola al comando de cada tab de Claude Code, con un
  `--mcp-config` escrito en ~/.controlcode/mcp/. No hace falta instalar la CLI para
  que funcione: el archivo apunta al binario que viene adentro de la app.

OTROS
  app status                                  Versión y estado de la app
  --json-args '{...}'                         Pasa argumentos crudos en JSON
  --version                                   Versión de esta CLI y del protocolo

`agents`, `accounts` y `skills` son atajos de `agent list`, `account list` y `skill list`.
Editar una skill que vino de un repositorio NO la pisa: guarda una copia de origen local y
deja la original recibiendo actualizaciones. `--copy` fuerza esa copia también para una
skill propia. `--file` se lee desde el directorio donde corrés el comando.
Sin --account, la tab usa la cuenta principal (la de siempre).
--pre se repite sin límite y sus valores corren EN EL ORDEN ESCRITO; si uno falla, el
agente no arranca. Cada valor puede ser el nombre de un guardado o un comando literal:
  ccode tab create --cwd . --agent claude-code --pre \"entorno conda\" --pre \"nvm use\"

La salida siempre es una línea JSON en stdout (salvo `mcp`, que habla JSON-RPC).
Códigos de salida: 0 ok · 1 el comando falló · 2 uso incorrecto · 3 la app no corre
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
        eprint!("{USAGE}");
        return ExitCode::from(if args.is_empty() { EXIT_USAGE } else { EXIT_OK });
    }
    if args[0] == "--version" || args[0] == "-V" {
        println!("{}", json!({ "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION }));
        return ExitCode::from(EXIT_OK);
    }

    // `ccode mcp` se atiende antes que nada: no devuelve una línea JSON como el resto,
    // sino que se queda con stdin y stdout hablando JSON-RPC con el agente que lo lanzó.
    // Mezclarlo con el parseo de flags normal le ensuciaría el canal.
    if args[0] == "mcp" {
        return run_mcp(&args[1..]);
    }

    // `ccode skills` / `ccode agents`: listar es lo único que se hace con ellos, y exigir
    // `skill list` para eso era ceremonia sin ganancia.
    let (command, flag_args) = match shortcut(&args[0]) {
        Some(cmd) => {
            // `ccode prelaunch` y `ccode prelaunch list` son lo mismo. Escribir la accion
            // igual es lo natural para quien viene de `ccode account list`, y sin esto
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
                eprintln!("Falta la acción para '{}'. Probá: ccode --help", args[0]);
                return ExitCode::from(EXIT_USAGE);
            }
            (format!("{}.{}", args[0], args[1]), &args[2..])
        }
    };

    let parsed = match parse_flags(flag_args, positionals(&command)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    // `--file` se resuelve ACÁ y viaja como `--content`: el archivo es relativo al cwd de
    // quien escribió el comando, no al de la app, y la app puede estar corriendo desde
    // cualquier otro lado. Además evita que el backend tenga que abrir rutas arbitrarias.
    let parsed = match inline_file(parsed) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    // Quién pregunta: la app le pone `ADE_TAB_ID` a cada terminal. Sin eso, la regla de
    // "solo a los conectados" no tendría contra qué comparar.
    let parsed = with_caller(&command, parsed);

    match send(&command, parsed) {
        Ok(response) => {
            let body = if response.ok {
                response.data.unwrap_or(Value::Null)
            } else {
                json!({ "error": response.error.unwrap_or_default() })
            };
            println!("{body}");
            ExitCode::from(if response.ok { EXIT_OK } else { EXIT_COMMAND_FAILED })
        }
        Err(e) => {
            println!("{}", json!({ "error": e.message }));
            ExitCode::from(e.code)
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
fn with_caller(command: &str, mut parsed: Value) -> Value {
    const GROUPS: [&str; 10] = ["peer.", "note.", "portal.", "device.", "notify.", "role.", "floor.", "routine.", "say.", "recall."];
    if !GROUPS.iter().any(|g| command.starts_with(g)) || parsed.get("from").is_some() {
        return parsed;
    }
    if let (Ok(tab), Some(map)) = (std::env::var("ADE_TAB_ID"), parsed.as_object_mut()) {
        map.insert("from".into(), Value::String(tab));
    }
    parsed
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
        "devices" => Some("device.list"),
        "pools" => Some("pool.list"),
        // `ccode notify "terminé"`: avisar es lo único que se hace con eso.
        "notify" => Some("notify.send"),
        "roles" => Some("role.list"),
        "floors" => Some("floor.list"),
        "routines" => Some("routine.list"),
        // `ccode say "pronto"`: hablarle al usuario es lo único que se hace con `say`.
        "say" => Some("say.send"),
        "recall" => Some("recall.get"),
        _ => None,
    }
}

/// Argumentos que se pueden escribir sueltos, en orden, sin su flag.
///
/// `ccode skill install git-helper` en vez de `--skill git-helper`. Solo se declara acá lo
/// que tiene un argumento obvio y único: si hubiera dudas sobre a qué flag corresponde un
/// valor suelto, es mejor exigir el flag que adivinar mal.
fn positionals(command: &str) -> &'static [&'static str] {
    match command {
        "skill.install" => &["skill"],
        "skill.show" | "skill.edit" => &["skill"],
        // `ccode skill new mi-skill` en vez de `--name mi-skill`.
        "skill.new" => &["name"],
        // `ccode skill search react` en vez de `--query react`.
        "skill.search" => &["query"],
        // El texto va segundo: `ccode tab send <id> "corré los tests"`.
        "tab.send" => &["tab", "text"],
        "tab.output" | "tab.close" | "watch.add" | "watch.remove" => &["tab"],
        "tab.create" => &["cwd"],
        "workspace.open" => &["workspace"],
        // `ccode mission wait <id>`, `ccode mission accept <id> <tarea>`.
        "mission.start" | "mission.status" | "mission.wait" | "mission.review" | "mission.apply" => &["mission"],
        "mission.accept" => &["mission", "task"],
        "approval.decide" => &["approval"],
        // `ccode peer ask Revisor "..."`: el nombre del agente y después el mensaje.
        "peer.ask" | "peer.tell" => &["to", "text"],
        "peer.check" => &["to"],
        "peer.recruit" => &["name"],
        "peer.connect" | "peer.disconnect" => &["a", "b"],
        // `ccode note read Plano 10 20`: desde la línea 10, 20 líneas.
        "notify.send" => &["message"],
        // `ccode role create "Revisor" "Procure falhas..."`; el texto también va con --file.
        "floor.create" => &["name"],
        "say.send" => &["text"],
        "recall.get" => &["thread"],
        // `ccode routine create Testes "rode os testes" --at 09:00`
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
        // `ccode portal click Web @e3`: el portal primero, después lo que cada acción pide.
        "portal.create" => &["name", "url"],
        "portal.navigate" => &["name", "url"],
        "portal.history" => &["name", "action"],
        "portal.click" | "portal.hover" => &["name", "target"],
        "portal.type" => &["name", "target", "text"],
        "portal.press" => &["name", "key"],
        "portal.select" => &["name", "target", "value"],
        // `ccode device tap Pixel --text Entrar`: el dispositivo primero, y lo que cada acción pide.
        "pool.create" | "pool.delete" => &["name"],
        "device.create" => &["name"],
        "device.start" | "device.shot" | "device.tree" => &["name"],
        "device.type" => &["name", "text"],
        "device.key" => &["name", "key"],
        "device.launch" => &["name", "package"],
        "device.tap" | "device.swipe" => &["name"],
        "portal.scroll" | "portal.wait" | "portal.snapshot" | "portal.screenshot" | "portal.console"
        | "portal.layout" => &["name"],
        _ => &[],
    }
}

/// `--flag valor` y `--flag` (booleano). Las claves se pasan a camelCase para que el
/// backend reciba los mismos nombres que usa el resto de la app (`--close-current` →
/// `closeCurrent`). `--skills a,b` se parte en array, que es lo que espera el frontend.
fn parse_flags(args: &[String], positionals: &[&str]) -> Result<Value, String> {
    let mut map = Map::new();
    let mut i = 0;

    // Valores sueltos al principio: `ccode skill install git-helper`. Solo al principio —
    // después de que aparece el primer `--flag`, una palabra suelta es casi siempre un
    // error de tipeo, y tragársela en silencio sería peor que rechazarla.
    let mut next = 0;
    while i < args.len() && !args[i].starts_with("--") {
        let Some(key) = positionals.get(next) else {
            return Err(format!(
                "Argumento inesperado '{}'. Este comando {}",
                args[i],
                if positionals.is_empty() {
                    "solo toma flags (empiezan con --)".to_string()
                } else {
                    format!("toma como máximo {} valor(es) suelto(s): {}", positionals.len(), positionals.join(", "))
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
            return Err(format!("Argumento inesperado '{raw}' (los flags empiezan con --)"));
        };

        // Escotilla para lo que el parseo simple no cubra (objetos anidados, etc.).
        if key == "json-args" {
            let value = args.get(i + 1).ok_or("--json-args necesita un valor")?;
            let extra: Value = serde_json::from_str(value)
                .map_err(|e| format!("--json-args no es JSON válido: {e}"))?;
            if let Value::Object(obj) = extra {
                map.extend(obj);
            } else {
                return Err("--json-args tiene que ser un objeto JSON".to_string());
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
                .ok_or_else(|| format!("--{key} necesita un valor"))?;
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

/// Reemplaza `--file <ruta>` por el contenido del archivo, en `content`.
///
/// Los dos no se pueden combinar: si vinieran juntos habría que elegir cuál gana, y
/// cualquier elección sería una sorpresa para quien mandó el otro.
fn inline_file(args: Value) -> Result<Value, String> {
    let Value::Object(mut map) = args else { return Ok(args) };
    let Some(file) = map.remove("file") else { return Ok(Value::Object(map)) };
    let Some(path) = file.as_str() else {
        return Err("--file necesita una ruta".to_string());
    };
    if map.contains_key("content") {
        return Err("Usá --file o --content, no los dos".to_string());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("No se pudo leer {path}: {e}"))?;
    map.insert("content".to_string(), Value::String(content));
    Ok(Value::Object(map))
}

fn value_for(key: &str, raw: &str) -> Value {
    match key {
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
        "lines" | "timeout" | "max" | "idle" | "start" | "count" | "turns" => {
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
        "mission.start" | "mission.accept" | "mission.apply" | "mission.review" => Duration::from_secs(180),
        // Los topes del backend suman ~40s (15 para que aparezca el PTY + 25 de arranque).
        "tab.create" if has_init_prompt(args) => Duration::from_secs(75),
        // `pick` espera a una persona; el resto son segundos.
        "browser.run" if args.pointer("/request/op").and_then(Value::as_str) == Some("pick") => {
            let asked = args.pointer("/request/timeout_s").and_then(Value::as_u64).unwrap_or(120).clamp(10, 600);
            Duration::from_secs(asked + 60)
        }
        "browser.run" => Duration::from_secs(controlcode_lib::ipc::mcp::BROWSER_TIMEOUT_SECS + 15),
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
                .unwrap_or(controlcode_lib::ipc::mcp::APPROVAL_TIMEOUT_SECS);
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
/// recibía "Control Code no parece estar corriendo", y Claude Code da por caído al servidor
/// entero por esa respuesta. También cubre el reinicio de la app con tareas en curso.
///
/// Solo para `ccode mcp`. Una persona que escribe `ccode tab list` con la app cerrada tiene
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
            "Control Code no parece estar corriendo (no se encontró {}). Abrí la app y volvé a intentar.",
            path.display()
        ))
    })?;

    // Reintentable: la app lo reescribe sola si quedó mal (ver `ipc::server::watch_handshakes`).
    let handshake: Handshake = serde_json::from_str(&raw)
        .map_err(|e| CliError::not_yet(format!("El archivo de handshake {} está corrupto ({e}); reiniciá la app", path.display())))?;

    if handshake.protocol != PROTOCOL_VERSION {
        // A propósito NO es reintentable: esperar no cambia la versión de nadie.
        return Err(CliError::new(
            format!(
                "La app habla el protocolo v{} y esta CLI la v{PROTOCOL_VERSION}. Actualizá la que haya quedado vieja.",
                handshake.protocol
            ),
            EXIT_NO_APP,
        ));
    }

    let stream = TcpStream::connect(("127.0.0.1", handshake.port)).map_err(|_| {
        CliError::not_yet(format!(
            "No se pudo conectar al puerto {} (la app con PID {} pudo haber cerrado). Reiniciá la app.",
            handshake.port, handshake.pid
        ))
    })?;
    let _ = stream.set_read_timeout(Some(read_timeout_for(command, &args)));

    let request = Request { token: handshake.token, command: command.to_string(), args };
    let payload = serde_json::to_string(&request).map_err(|e| CliError::new(e.to_string(), EXIT_USAGE))?;

    let mut writer = stream.try_clone().map_err(|e| CliError::new(e.to_string(), EXIT_NO_APP))?;
    writeln!(writer, "{payload}").and_then(|_| writer.flush()).map_err(|e| CliError::new(format!("No se pudo enviar el comando: {e}"), EXIT_NO_APP))?;

    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| CliError::new(format!("No llegó respuesta: {e}"), EXIT_NO_APP))?;

    serde_json::from_str(&line).map_err(|e| CliError::new(format!("Respuesta ilegible de la app: {e}"), EXIT_NO_APP))
}

/// `ccode mcp`: el puente MCP de un agente. Con `--task` es el de una tarea de la flota
/// (permisos y navegador); con `--cwd`, el de una tab de Claude Code (solo el navegador).
///
/// Cada pedido se traduce a un comando del mismo protocolo que usa el resto de la CLI, así
/// que no hay un canal nuevo ni una autorización nueva — el token del handshake es el
/// mismo. Los errores van a stderr: stdout es del JSON-RPC y meterle una línea suelta
/// rompe al cliente.
fn run_mcp(args: &[String]) -> ExitCode {
    use controlcode_lib::ipc::mcp::McpContext;

    // Por nombre y no por posición: OpenCode escribe el comando entero en un arreglo de su
    // config, y no hay razón para que el orden en que lo escriba alguien a mano tenga que
    // coincidir con el que escribe la app.
    let mut flags: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            name @ ("--task" | "--cwd" | "--tab" | "--prefix") => {
                let Some(value) = rest.next() else {
                    eprintln!("Falta el valor de {name}");
                    return ExitCode::from(EXIT_USAGE);
                };
                flags.insert(name, value.clone());
            }
            other => {
                eprintln!("Argumento inesperado para 'ccode mcp': {other}");
                return ExitCode::from(EXIT_USAGE);
            }
        }
    }

    let context = match (flags.remove("--task"), flags.remove("--cwd")) {
        (Some(task), _) => McpContext::Task(task),
        (None, Some(cwd)) => McpContext::Cwd { cwd, tab: flags.remove("--tab") },
        (None, None) => {
            eprintln!(
                "Uso: ccode mcp --task <id-de-tarea> | --cwd <carpeta> [--tab <id-de-tab>] [--prefix <prefijo>]"
            );
            return ExitCode::from(EXIT_USAGE);
        }
    };
    // Lo que esta TUI le antepone al nombre de cada tool. Vacío = no antepone nada.
    let prefix = flags.remove("--prefix").unwrap_or_default();

    let stdin = std::io::stdin();
    let result = controlcode_lib::ipc::mcp::serve(
        &context,
        &prefix,
        stdin.lock(),
        std::io::stdout(),
        |command, payload| {
            let response = send_waiting(command, payload).map_err(|e| e.message)?;
            if response.ok {
                Ok(response.data.unwrap_or(Value::Null))
            } else {
                Err(response.error.unwrap_or_else(|| "la app rechazó el pedido".into()))
            }
        },
    );

    match result {
        Ok(()) => ExitCode::from(EXIT_OK),
        Err(e) => {
            eprintln!("ccode mcp: {e}");
            ExitCode::from(EXIT_COMMAND_FAILED)
        }
    }
}

// El archivo vive fuera de `src/bin/` a propósito: el bundler de Tauri trata CADA entrada
// de ese directorio como un ejecutable a empaquetar, así que una carpeta `cli/` al lado de
// `cli.rs` le hacía buscar un binario `cli` que no existe y abortaba el empaquetado.
#[cfg(test)]
#[path = "../cli_test.rs"]
mod test;
