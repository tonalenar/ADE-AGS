use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::{folder_for, migrate, report, Folder, MigrationSummary};
use crate::database::DbConnection;
use crate::memory::agent::looks_like_secret;

const WS: &str = "ws-f4";
/// Binário falso: registra argv (uma linha por chamada) e a entrada padrão, e guarda as páginas em
/// arquivos. Nenhum ai-memory real é executado.
const FAKE: &str = r#"#!/bin/sh
ROOT='__ROOT__'
[ "$AI_MEMORY_RUN_AUTOWIRE" = false ] || exit 70
[ "$AI_MEMORY_EMBEDDING_PROVIDER" = none ] || exit 71
[ "$AI_MEMORY_HOST_CWD" -ef "$PWD" ] || exit 72
[ -z "$AI_MEMORY_SCOPE_CWD" ] || exit 73
echo "$*" >> "$ROOT/argv.log"
if [ "$1" = --version ]; then echo 'ai-memory 3.3.0'; exit 0; fi
P=
for a in "$@"; do case "$a" in --path=*) P=${a#--path=} ;; esac; done
F="$ROOT/pages/$(printf '%s' "$P" | tr '/' '_')"
case "$1" in
read-page)
  if [ ! -f "$F" ]; then echo 'Error: GET /admin/read-page: server returned 404 Not Found: {"error":"No such file"}' >&2; exit 1; fi
  printf '{"path":"%s","workspace":"WS-FAKE","project":"projeto-fake","title":null,"body":"%s","frontmatter":null,"expired":false}\n' "$P" "$(sed -e 's/"/\\"/g' "$F" | awk 'NR>1{printf "\\n"} {printf "%s",$0}')"
  exit 0 ;;
write-page)
  echo "$PWD" >> "$ROOT/cwd.log"
  cat > "$ROOT/stdin.tmp"
  cat "$ROOT/stdin.tmp" >> "$ROOT/stdin.log"
  n=$(grep -c '^write-page' "$ROOT/argv.log")
  if [ -f "$ROOT/fail-from" ] && [ "$n" -ge "$(cat "$ROOT/fail-from")" ]; then echo 'boom' >&2; exit 1; fi
  if [ -f "$ROOT/tamper" ]; then echo 'alterado pelo servidor' >> "$ROOT/stdin.tmp"; fi
  mv "$ROOT/stdin.tmp" "$F"
  echo "✓ wrote $P"; exit 0 ;;
*) exit 2 ;;
esac
"#;

struct Env {
    root: PathBuf,
    folder: PathBuf,
    program: PathBuf,
    db: DbConnection,
}

impl Env {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ade-f4-{}", uuid::Uuid::new_v4()));
        let folder = root.join("projeto");
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(root.join("pages")).unwrap();
        let program = root.join("fake-ai-memory");
        fs::write(&program, FAKE.replace("__ROOT__", &root.display().to_string())).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let conn = crate::memory::fixtures::create_temp_db();
        conn.execute_batch(&format!(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('{WS}', 'WS F4', 1, 1);
             INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws-vazio', 'Vazio', 1, 1);"
        ))
        .unwrap();
        let env = Self { root, folder, program, db: Arc::new(Mutex::new(conn)) };
        env.mission("m-base", WS);
        env
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(&self.db.lock().unwrap())
    }

    fn mission(&self, id: &str, workspace: &str) {
        self.mission_at(id, workspace, &self.folder, 1);
    }

    fn mission_at(&self, id: &str, workspace: &str, cwd: &Path, created_at: i64) {
        let cwd = cwd.display().to_string();
        self.with(|c| {
            c.execute(
                "INSERT INTO missions (id, workspace_id, title, objective, cwd, created_at, updated_at)
                 VALUES (?1, ?2, 'Missão', 'objetivo', ?3, ?4, ?4)",
                params![id, workspace, cwd, created_at],
            )
            .unwrap();
        });
    }

    /// Pasta com `.git/config` de origin `git@github.com:acme/<name>.git`: o repo_key sai daí.
    fn repo(&self, name: &str) -> PathBuf {
        let dir = self.root.join(name);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(
            dir.join(".git/config"),
            format!("[remote \"origin\"]\n\turl = git@github.com:acme/{name}.git\n"),
        )
        .unwrap();
        dir
    }

    fn plain(&self, name: &str) -> PathBuf {
        let dir = self.root.join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(&self) -> Result<MigrationSummary, String> {
        migrate(&self.db, WS, Some(self.program.clone()), None)
    }

    fn run_in(&self, cwd: &Path) -> Result<MigrationSummary, String> {
        migrate(&self.db, WS, Some(self.program.clone()), Some(&cwd.display().to_string()))
    }

    /// Pastas (basename) em que o fake escreveu, na ordem das chamadas.
    fn write_folders(&self) -> Vec<String> {
        fs::read_to_string(self.root.join("cwd.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| Path::new(l).file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    fn set_repo(&self, entry: &str, key: Option<&str>) {
        self.with(|c| {
            c.execute("UPDATE memory_entries SET repo_key = ?2 WHERE id = ?1", params![entry, key]).unwrap();
        });
    }

    fn page(&self, path: &str) -> PathBuf {
        self.root.join("pages").join(path.replace('/', "_"))
    }

    fn argv(&self) -> String {
        fs::read_to_string(self.root.join("argv.log")).unwrap_or_default()
    }

    fn write_calls(&self) -> usize {
        self.argv().lines().filter(|l| l.starts_with("write-page")).count()
    }

    fn stdin_log(&self) -> String {
        fs::read_to_string(self.root.join("stdin.log")).unwrap_or_default()
    }

    fn registry(&self) -> Vec<(String, String, Option<String>)> {
        self.with(|c| {
            let mut stmt = c
                .prepare("SELECT entry_id, status, reason FROM ai_memory_migration ORDER BY entry_id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Mesmo hash que o ADE grava em `memory_revisions.content_hash` (`sha256(kind\0body)`).
fn content_hash(kind: &str, body: &str) -> String {
    hex(&Sha256::digest(format!("{kind}\0{body}").as_bytes()))
}

/// Uma memória com suas revisões. Cada revisão: (número, status, operação, corpo).
/// A assinatura espelha as colunas de `memory_entries`, por isso passa de sete argumentos.
#[allow(clippy::too_many_arguments)]
fn entry(
    c: &Connection,
    id: &str,
    scope: &str,
    mission: Option<&str>,
    key: &str,
    kind: &str,
    status: &str,
    current: Option<i64>,
    revisions: &[(i64, &str, &str, &str)],
) {
    c.execute(
        "INSERT INTO memory_entries (id, scope, workspace_id, mission_id, key, kind, status, current_revision,
                                     priority, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 1, 1)",
        params![id, scope, WS, mission, key, kind, status, current],
    )
    .unwrap();
    for (revision, rev_status, operation, body) in revisions {
        let decided: Option<i64> = (*rev_status != "proposed").then_some(1);
        c.execute(
            "INSERT INTO memory_revisions (entry_id, revision, status, operation, kind, priority, body,
                                           content_hash, actor_kind, created_at, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, 'user', 1, ?8)",
            params![id, revision, rev_status, operation, kind, body, content_hash(kind, body), decided],
        )
        .unwrap();
    }
}

/// Uma memória aprovada e atual, de escopo workspace, com um corpo.
fn approved(env: &Env, id: &str, kind: &str, body: &str) {
    env.with(|c| entry(c, id, "workspace", None, &format!("chave-{id}"), kind, "active", Some(1), &[(1, "approved", "create", body)]));
}

/// Snapshot das tabelas de memória: qualquer UPDATE, DELETE ou INSERT muda a lista.
fn memory_snapshot(env: &Env) -> Vec<String> {
    env.with(|c| {
        let mut out = Vec::new();
        for table in ["memory_entries", "memory_revisions"] {
            let mut stmt = c.prepare(&format!("SELECT * FROM {table} ORDER BY rowid")).unwrap();
            let cols = stmt.column_count();
            let rows = stmt
                .query_map([], |row| {
                    let mut parts = Vec::new();
                    for i in 0..cols {
                        parts.push(format!("{:?}", row.get::<_, rusqlite::types::Value>(i)?));
                    }
                    Ok(parts.join("|"))
                })
                .unwrap();
            for row in rows {
                out.push(format!("{table}:{}", row.unwrap()));
            }
        }
        out
    })
}

#[test]
fn copia_so_o_aprovado_atual_e_deixa_fora_pendente_rejeitada_tombstone_e_revisao_antiga() {
    let env = Env::new();
    env.with(|c| {
        // A: aprovada e atual.
        entry(c, "e1-aprovada", "workspace", None, "a", "decision", "active", Some(1), &[(1, "approved", "create", "decisão A")]);
        // B: só proposta pendente.
        entry(c, "e2-pendente", "workspace", None, "b", "note", "active", None, &[(1, "proposed", "create", "pendente B")]);
        // C: rejeitada.
        entry(c, "e3-rejeitada", "workspace", None, "c", "note", "active", None, &[(1, "rejected", "create", "rejeitada C")]);
        // D: tombstone (criada e apagada).
        entry(c, "e4-tombstone", "workspace", None, "d", "note", "deleted", None, &[(1, "approved", "create", "apagada D"), (2, "approved", "delete", "apagada D")]);
        // E: revisão antiga 1; atual 2.
        entry(c, "e5-revisada", "workspace", None, "e", "finding", "active", Some(2), &[(1, "approved", "create", "versão antiga"), (2, "approved", "update", "versão atual")]);
        // F: atual 1; revisão 2 só proposta (fica de fora, a atual vale).
        entry(c, "e6-com-pendente", "workspace", None, "f", "file", "active", Some(1), &[(1, "approved", "create", "fica F"), (2, "proposed", "update", "pendente F")]);
    });

    let summary = env.run().unwrap();

    assert_eq!(summary.written, 3, "{summary:?}");
    assert!(env.page("ade/memoria/e1-aprovada.md").exists());
    assert!(env.page("ade/memoria/e5-revisada.md").exists());
    assert!(env.page("ade/memoria/e6-com-pendente.md").exists());
    for fora in ["e2-pendente", "e3-rejeitada", "e4-tombstone"] {
        assert!(!env.page(&format!("ade/memoria/{fora}.md")).exists(), "{fora} não deveria migrar");
    }
    let revisada = fs::read_to_string(env.page("ade/memoria/e5-revisada.md")).unwrap();
    assert!(revisada.contains("versão atual") && !revisada.contains("versão antiga"), "{revisada}");
    let fica = fs::read_to_string(env.page("ade/memoria/e6-com-pendente.md")).unwrap();
    assert!(fica.contains("fica F") && !fica.contains("pendente F"), "{fica}");
    assert_eq!(env.write_calls(), 3);
}

#[test]
fn escopo_de_missao_vai_para_ade_missoes_e_pin_so_em_decisao_e_restricao() {
    let env = Env::new();
    env.with(|c| {
        entry(c, "m-regra", "mission", Some("m-base"), "regra", "constraint", "active", Some(1), &[(1, "approved", "create", "usar bun")]);
        entry(c, "m-nota", "workspace", None, "nota", "note", "active", Some(1), &[(1, "approved", "create", "uma nota")]);
    });

    env.run().unwrap();

    let argv = env.argv();
    let regra = argv.lines().find(|l| l.starts_with("write-page") && l.contains("m-regra.md")).expect("chamada da regra");
    assert!(regra.contains("--path=ade/missoes/m-base/m-regra.md"), "{regra}");
    assert!(regra.contains("--kind=rule") && regra.contains("--pinned"), "{regra}");
    assert!(regra.contains("--tag=ade-missao:m-base") && regra.contains("--tag=ade-migrado"), "{regra}");
    let nota = argv.lines().find(|l| l.starts_with("write-page") && l.contains("m-nota.md")).expect("chamada da nota");
    assert!(nota.contains("--kind=fact") && !nota.contains("--pinned"), "{nota}");
    assert!(!nota.contains("ade-missao"), "{nota}");
}

#[test]
fn corpo_vai_pela_entrada_padrao_e_o_ttl_so_fica_no_rodape() {
    let env = Env::new();
    env.with(|c| {
        entry(c, "e-ttl", "workspace", None, "ttl", "decision", "active", Some(1), &[(1, "approved", "create", "CORPO_SECRETO_NAO_NA_ARGV")]);
        c.execute("UPDATE memory_entries SET ttl_days = 7 WHERE id = 'e-ttl'", []).unwrap();
    });

    env.run().unwrap();

    let argv = env.argv();
    assert!(!argv.contains("--workspace") && !argv.contains("--project"), "{argv}");
    assert!(!argv.contains("CORPO_SECRETO_NAO_NA_ARGV"), "o corpo não pode ir na linha de comando: {argv}");
    assert!(argv.contains("--body -"), "{argv}");
    let stdin = env.stdin_log();
    assert!(stdin.contains("CORPO_SECRETO_NAO_NA_ARGV"), "{stdin}");
    assert!(stdin.contains("ade_entry_id: e-ttl") && stdin.contains("ttl_days: 7"), "{stdin}");
    assert!(stdin.contains("# ttl\n\n"), "{stdin}");
}

#[test]
fn segunda_execucao_nao_escreve_de_novo() {
    let env = Env::new();
    approved(&env, "e1", "decision", "primeira");
    approved(&env, "e2", "note", "segunda");

    let first = env.run().unwrap();
    assert_eq!(first.written, 2);
    let calls = env.write_calls();

    let second = env.run().unwrap();
    assert_eq!(second.already, 2, "{second:?}");
    assert_eq!(second.written, 0);
    assert_eq!(env.write_calls(), calls, "a segunda execução não pode chamar write-page");
}

#[test]
fn segredo_nunca_migra_mesmo_com_padrao_de_credencial() {
    let env = Env::new();
    let credencial = "sk-abcdefghijklmnopqrstuvwxyzABCDEF12";
    assert!(looks_like_secret(credencial), "o teste precisa de um segredo que o detector reconheça");
    approved(&env, "e-segredo", "note", &format!("use a chave {credencial}"));
    approved(&env, "e-normal", "note", "texto comum");

    let summary = env.run().unwrap();

    assert_eq!(summary.skipped_secret, 1, "{summary:?}");
    assert_eq!(summary.written, 1);
    assert!(!env.stdin_log().contains("sk-abcdef"), "o segredo não pode chegar ao processo");
    assert!(!env.argv().contains("sk-abcdef"));
    assert!(!env.page("ade/memoria/e-segredo.md").exists());
    let registro = env.registry();
    assert!(registro.iter().any(|(id, status, _)| id == "e-segredo" && status == "skipped_secret"), "{registro:?}");
}

#[test]
fn pagina_que_ja_existia_sem_registro_vira_conflito_e_nao_e_sobrescrita() {
    let env = Env::new();
    approved(&env, "e1", "decision", "minha versão");
    let path = "ade/memoria/e1.md";
    fs::write(env.page(path), "conteúdo do usuário, não nosso").unwrap();

    let summary = env.run().unwrap();

    assert_eq!(summary.conflict, 1, "{summary:?}");
    assert_eq!(summary.written, 0);
    assert_eq!(env.write_calls(), 0, "conflito não pode escrever");
    assert_eq!(fs::read_to_string(env.page(path)).unwrap(), "conteúdo do usuário, não nosso");
}

#[test]
fn pagina_editada_depois_da_copia_vira_divergente_e_nao_e_sobrescrita() {
    let env = Env::new();
    approved(&env, "e1", "decision", "copiada");
    env.run().unwrap();
    let path = env.page("ade/memoria/e1.md");
    fs::write(&path, "editada no ai-memory").unwrap();
    let calls = env.write_calls();

    let summary = env.run().unwrap();

    assert_eq!(summary.divergent, 1, "{summary:?}");
    assert_eq!(env.write_calls(), calls, "divergente não pode escrever");
    assert_eq!(fs::read_to_string(&path).unwrap(), "editada no ai-memory");
}

#[test]
fn verificacao_com_corpo_diferente_vira_failed() {
    let env = Env::new();
    approved(&env, "e1", "decision", "verificar");
    fs::write(env.root.join("tamper"), "").unwrap();

    let summary = env.run().unwrap();

    assert_eq!(summary.failed, 1, "{summary:?}");
    assert_eq!(summary.written, 0);
    let registro = env.registry();
    assert!(registro.iter().any(|(id, status, reason)| id == "e1" && status == "failed" && reason.as_deref().unwrap_or("").contains("verificação")), "{registro:?}");
}

#[test]
fn falha_do_processo_para_a_copia_e_o_que_ja_foi_gravado_fica_no_registro() {
    let env = Env::new();
    approved(&env, "e1", "decision", "um");
    approved(&env, "e2", "decision", "dois");
    approved(&env, "e3", "decision", "tres");
    // Falha a partir da 2ª chamada de escrita.
    fs::write(env.root.join("fail-from"), "2").unwrap();

    let summary = env.run().unwrap();

    assert_eq!(summary.written, 1, "{summary:?}");
    assert!(summary.stopped.is_some(), "{summary:?}");
    assert_eq!(env.write_calls(), 2, "a 3ª entrada não pode ser tentada depois da parada");
    let registro = env.registry();
    assert_eq!(registro.len(), 1, "{registro:?}");
    assert_eq!(registro[0].0, "e1");
    assert_eq!(registro[0].1, "written");

    // Reexecutar com o servidor de volta retoma sem duplicar a primeira.
    fs::remove_file(env.root.join("fail-from")).unwrap();
    let retomada = env.run().unwrap();
    assert_eq!(retomada.already, 1, "{retomada:?}");
    assert_eq!(retomada.written, 2, "{retomada:?}");
}

#[test]
fn workspace_sem_pasta_pula_com_motivo_e_nao_chama_o_processo() {
    let env = Env::new();
    env.with(|c| {
        entry(c, "x1", "workspace", None, "x", "note", "active", Some(1), &[(1, "approved", "create", "sem pasta")]);
    });
    let summary = migrate(&env.db, "ws-vazio", Some(env.program.clone()), None).unwrap();

    assert!(summary.reason.as_deref().unwrap_or("").contains("sem pasta"), "{summary:?}");
    assert_eq!(summary.written + summary.failed + summary.conflict, 0);
    assert_eq!(env.write_calls(), 0);
}

#[test]
fn sem_binario_e_erro_antes_de_tocar_no_registro() {
    let env = Env::new();
    approved(&env, "e1", "decision", "sem binário");

    assert!(migrate(&env.db, WS, None, None).is_err());
    assert!(env.registry().is_empty());
}

#[test]
fn tabelas_de_memoria_nao_mudam_com_a_copia_inteira() {
    let env = Env::new();
    env.with(|c| {
        entry(c, "t-a", "workspace", None, "a", "decision", "active", Some(1), &[(1, "approved", "create", "a")]);
        entry(c, "t-b", "workspace", None, "b", "note", "active", None, &[(1, "proposed", "create", "b")]);
        entry(c, "t-c", "workspace", None, "c", "note", "deleted", None, &[(1, "approved", "create", "c"), (2, "approved", "delete", "c")]);
        entry(c, "t-d", "workspace", None, "d", "decision", "active", Some(1), &[(1, "approved", "create", "d")]);
    });
    env.with(|c| {
        // Um segredo para cobrir também o ramo de recusa.
        entry(c, "t-s", "workspace", None, "s", "note", "active", Some(1), &[(1, "approved", "create", "sk-abcdefghijklmnopqrstuvwxyzABCDEF12")]);
    });
    let antes = memory_snapshot(&env);

    env.run().unwrap();
    env.run().unwrap();

    assert_eq!(memory_snapshot(&env), antes, "nenhuma linha das tabelas de memória pode mudar");
}

#[test]
fn tabela_aditiva_existe_e_user_version_nao_sobe() {
    let env = Env::new();
    let (existe, versao): (bool, i64) = env.with(|c| {
        let existe = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_memory_migration')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let versao = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        (existe, versao)
    });
    assert!(existe);
    // A versão do schema continua 45: a tabela nova é aditiva e não sobe user_version (ver database/test.rs).
    assert_eq!(versao, 45);
}

fn pasta(cwd: &str, key: Option<&str>) -> Folder {
    Folder { cwd: cwd.into(), repo_key: key.map(String::from) }
}

#[test]
fn escolhe_a_pasta_na_ordem_da_aba_da_missao_e_da_recente() {
    let missoes = vec![pasta("/missao-b", Some("acme/b")), pasta("/missao-a", Some("acme/a"))];
    let aba_a = pasta("/aba-a", Some("acme/a"));
    let aba_z = pasta("/aba-z", Some("acme/z"));
    let aba_sem_repo = pasta("/aba-simples", None);

    // 1. memória com repo_key igual ao da aba: vence a aba, mesmo com missão do mesmo repo.
    assert_eq!(folder_for(&missoes, Some(&aba_a), Some("acme/a")), Some("/aba-a"));
    // 2. repo_key de outro repositório que não o da aba: vai para a missão desse repositório.
    assert_eq!(folder_for(&missoes, Some(&aba_z), Some("acme/a")), Some("/missao-a"));
    assert_eq!(folder_for(&missoes, None, Some("acme/b")), Some("/missao-b"));
    // 3. sem repo_key: a aba, se veio; senão a missão mais recente (a primeira da lista).
    assert_eq!(folder_for(&missoes, Some(&aba_sem_repo), None), Some("/aba-simples"));
    assert_eq!(folder_for(&missoes, None, None), Some("/missao-b"));
    // 4. nenhum caminho: sem pasta.
    assert_eq!(folder_for(&missoes, Some(&aba_z), Some("acme/c")), None);
    assert_eq!(folder_for(&[], None, Some("acme/c")), None);
    assert_eq!(folder_for(&[], None, None), None);
}

/// Cada ramo da escolha de pasta, com o binário fake: o `cwd.log` mostra onde cada escrita rodou.
#[test]
fn ramo_1_a_pasta_da_aba_com_o_mesmo_repositorio_vence_a_missao() {
    let env = Env::new();
    let aba = env.repo("aba-acme");
    let outra = env.repo("missao-outra");
    env.mission_at("m-outra", WS, &outra, 5);
    env.with(|c| entry(c, "e-r1", "workspace", None, "r1", "note", "active", Some(1), &[(1, "approved", "create", "ramo 1")]));
    let chave = crate::memory::repo_scope::repo_key(&aba).unwrap();
    env.set_repo("e-r1", Some(&chave));
    // A missão tem outro repositório: só a aba casa com a memória.
    assert_ne!(crate::memory::repo_scope::repo_key(&outra), Some(chave.clone()));

    let summary = env.run_in(&aba).unwrap();

    assert_eq!(summary.written, 1, "{summary:?}");
    assert_eq!(env.write_folders(), vec!["aba-acme"]);
}

#[test]
fn ramo_2_sem_a_aba_no_repositorio_a_missao_com_o_mesmo_repositorio_e_usada() {
    let env = Env::new();
    let aba = env.repo("aba-outra-coisa");
    let missao = env.repo("missao-acme");
    env.mission_at("m-acme", WS, &missao, 5);
    env.with(|c| entry(c, "e-r2", "workspace", None, "r2", "note", "active", Some(1), &[(1, "approved", "create", "ramo 2")]));
    let chave = crate::memory::repo_scope::repo_key(&missao).unwrap();
    env.set_repo("e-r2", Some(&chave));

    let summary = env.run_in(&aba).unwrap();

    assert_eq!(summary.written, 1, "{summary:?}");
    assert_eq!(env.write_folders(), vec!["missao-acme"]);
}

#[test]
fn ramo_3_sem_repo_key_vai_para_a_aba_quando_ela_veio() {
    let env = Env::new();
    let aba = env.plain("aba-simples");
    let recente = env.repo("missao-recente");
    env.mission_at("m-recente", WS, &recente, 9);
    env.with(|c| entry(c, "e-r3a", "workspace", None, "r3a", "note", "active", Some(1), &[(1, "approved", "create", "ramo 3a")]));

    let summary = env.run_in(&aba).unwrap();

    assert_eq!(summary.written, 1, "{summary:?}");
    assert_eq!(env.write_folders(), vec!["aba-simples"]);
}

#[test]
fn ramo_3_sem_repo_key_e_sem_aba_vai_para_a_missao_mais_recente() {
    let env = Env::new();
    let antiga = env.repo("missao-antiga");
    let recente = env.repo("missao-recente");
    env.mission_at("m-antiga", WS, &antiga, 1);
    env.mission_at("m-recente", WS, &recente, 9);
    env.with(|c| entry(c, "e-r3b", "workspace", None, "r3b", "note", "active", Some(1), &[(1, "approved", "create", "ramo 3b")]));

    let summary = env.run().unwrap();

    assert_eq!(summary.written, 1, "{summary:?}");
    assert_eq!(env.write_folders(), vec!["missao-recente"]);
}

#[test]
fn ramo_4_sem_nenhuma_pasta_compativel_pula_com_motivo_e_nao_escreve() {
    let env = Env::new();
    let aba = env.repo("aba-z");
    let missao = env.repo("missao-b");
    env.mission_at("m-b", WS, &missao, 5);
    env.with(|c| entry(c, "e-r4", "workspace", None, "r4", "note", "active", Some(1), &[(1, "approved", "create", "ramo 4")]));
    env.set_repo("e-r4", Some("github.com/acme/sem-pasta"));

    let summary = env.run_in(&aba).unwrap();

    assert_eq!(summary.failed, 1, "{summary:?}");
    assert_eq!(summary.written, 0);
    assert!(env.write_folders().is_empty(), "sem pasta não pode chamar o processo");
    let registro = env.registry();
    assert!(
        registro.iter().any(|(id, status, reason)| id == "e-r4" && status == "failed" && reason.as_deref().unwrap_or("").contains("sem pasta")),
        "{registro:?}"
    );
}

#[test]
fn a_pasta_da_aba_precisa_ser_um_diretorio_absoluto() {
    let env = Env::new();
    approved(&env, "e-cwd", "note", "x");
    assert!(migrate(&env.db, WS, Some(env.program.clone()), Some("relativo/caminho")).is_err());
    assert!(migrate(&env.db, WS, Some(env.program.clone()), Some("/nao/existe/mesmo")).is_err());
    assert!(env.registry().is_empty());
}

#[test]
fn relatorio_traz_o_registro_do_workspace_sem_corpo() {
    let env = Env::new();
    approved(&env, "e1", "decision", "corpo que não pode aparecer no relatório");
    env.run().unwrap();

    let linhas = report(&env.db, WS).unwrap();

    assert_eq!(linhas.len(), 1, "{linhas:?}");
    assert_eq!(linhas[0].status, "written");
    assert_eq!(linhas[0].key.as_deref(), Some("chave-e1"), "a chave vem de memory_entries");
    assert_eq!(linhas[0].wiki_path.as_deref(), Some("ade/memoria/e1.md"));
    assert_eq!(linhas[0].aim_workspace.as_deref(), Some("WS-FAKE"));
    assert_eq!(linhas[0].aim_project.as_deref(), Some("projeto-fake"));
    assert!(report(&env.db, "ws-vazio").unwrap().is_empty());
}

#[test]
fn escrita_recusa_titulo_tipo_e_tag_invalidos_antes_do_processo() {
    use crate::ai_memory::client::PageWrite;
    let tags = vec!["ade".to_string()];
    let ruim_titulo = PageWrite { path: "ade/memoria/x.md", title: "", kind: "fact", tags: &tags, pinned: false };
    assert!(ruim_titulo.check().is_err());
    let ruim_tipo = PageWrite { path: "ade/memoria/x.md", title: "ok", kind: "decisao", tags: &tags, pinned: false };
    assert!(ruim_tipo.check().is_err());
    let com_espaco = vec!["ade migrado".to_string()];
    let ruim_tag = PageWrite { path: "ade/memoria/x.md", title: "ok", kind: "fact", tags: &com_espaco, pinned: false };
    assert!(ruim_tag.check().is_err());
    let travessia = PageWrite { path: "../x.md", title: "ok", kind: "fact", tags: &tags, pinned: false };
    assert!(travessia.check().is_err());
    let boa = PageWrite { path: "ade/memoria/x.md", title: "ok", kind: "rule", tags: &tags, pinned: true };
    assert!(boa.check().is_ok());
}
