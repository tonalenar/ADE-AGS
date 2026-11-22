use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use rusqlite::params;
use serde_json::json;

use super::commands::{
    ForgeClient, set_auto_db, set_enabled_db, setup_with, status_db, sync_now_with,
};
use super::credentials::{EphemeralAskpass, fetch_credential_over_loopback};
use super::repo::{RemoteCredentials, build_network_git_spec, mirror_dir};
use crate::database::DbConnection;
use crate::forge::for_sync::{Api, ForgeError, ForgeKind, ForgeRepo};
use crate::memory::{ProposalActor, ProposalInput, decide, propose};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("ade-memsync-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=Teste", "-c", "user.email=teste@example.invalid"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} falhou: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_bare_remote(root: &Path, name: &str) -> PathBuf {
    let bare = root.join(name);
    std::fs::create_dir_all(&bare).unwrap();
    run_git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    bare
}

fn remote_tree_files(bare: &Path, branch: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let check = std::process::Command::new("git")
        .arg("-C")
        .arg(bare)
        .args(["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")])
        .output()
        .unwrap();
    if !check.status.success() {
        return out;
    }
    let listing = run_git(bare, &["ls-tree", "-r", "--name-only", branch]);
    for path in listing.lines().filter(|l| !l.is_empty()) {
        let content = run_git(bare, &["show", &format!("{branch}:{path}")]);
        out.insert(path.to_string(), content);
    }
    out
}

fn remote_commit_count(bare: &Path, branch: &str) -> usize {
    let check = std::process::Command::new("git")
        .arg("-C")
        .arg(bare)
        .args(["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")])
        .output()
        .unwrap();
    if !check.status.success() {
        return 0;
    }
    run_git(bare, &["rev-list", "--count", branch])
        .parse()
        .unwrap_or(0)
}

#[derive(Clone)]
struct FakeForge {
    repos: Arc<Mutex<BTreeMap<String, ForgeRepo>>>,
    fail_find: Arc<AtomicBool>,
    create_as_public: Arc<AtomicBool>,
    find_calls: Arc<AtomicUsize>,
}

impl FakeForge {
    fn new() -> Self {
        Self {
            repos: Arc::new(Mutex::new(BTreeMap::new())),
            fail_find: Arc::new(AtomicBool::new(false)),
            create_as_public: Arc::new(AtomicBool::new(false)),
            find_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn insert_repo(&self, full_name: &str, private: bool, bare_path: &Path) {
        let repo = ForgeRepo {
            full_name: full_name.to_string(),
            description: Some("Memórias".into()),
            private,
            fork: false,
            archived: false,
            clone_url: bare_path.to_string_lossy().into_owned(),
            ssh_url: None,
            web_url: format!("https://github.com/{full_name}"),
            default_branch: Some("main".into()),
            updated_at: None,
        };
        self.repos.lock().unwrap().insert(full_name.to_string(), repo);
    }

    fn set_private(&self, full_name: &str, private: bool) {
        if let Some(repo) = self.repos.lock().unwrap().get_mut(full_name) {
            repo.private = private;
        }
    }
}

impl ForgeClient for FakeForge {
    async fn find_repo(&self, full_name: &str) -> Result<Option<ForgeRepo>, ForgeError> {
        self.find_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_find.load(Ordering::SeqCst) {
            return Err(ForgeError::Api("falha simulada na API do forge".into()));
        }
        Ok(self.repos.lock().unwrap().get(full_name).cloned())
    }

    async fn create_private_repo(&self, name: &str, description: &str) -> Result<ForgeRepo, ForgeError> {
        let full_name = format!("ton/{name}");
        let bare = std::env::temp_dir().join(format!("ade-fake-created-{}.git", uuid::Uuid::new_v4()));
        init_bare_remote(&bare.parent().unwrap(), bare.file_name().unwrap().to_str().unwrap());
        let repo = ForgeRepo {
            full_name: full_name.clone(),
            description: Some(description.to_string()),
            private: !self.create_as_public.load(Ordering::SeqCst),
            fork: false,
            archived: false,
            clone_url: bare.to_string_lossy().into_owned(),
            ssh_url: None,
            web_url: format!("https://github.com/{full_name}"),
            default_branch: Some("main".into()),
            updated_at: None,
        };
        self.repos.lock().unwrap().insert(full_name, repo.clone());
        Ok(repo)
    }
}

fn test_db_arc() -> DbConnection {
    let conn = crate::database::test_db();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'Projeto Principal', 100, 100)",
        [],
    )
    .unwrap();
    Arc::new(Mutex::new(conn))
}

fn approve_sqlite_memory(db: &DbConnection, workspace: &str, key: &str, kind: &str, body: &str, acknowledge_secret: bool) {
    let conn = db.lock().unwrap();
    let res = propose(
        &conn,
        "workspace",
        workspace,
        None,
        &ProposalInput {
            scope: "workspace".into(),
            key: key.into(),
            kind: kind.into(),
            body: body.into(),
            priority: 3,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: Some("decisão importante".into()),
            acknowledge_secret,
        },
        ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None },
    )
    .unwrap();
    decide(&conn, &res.entry_id, res.revision, true).unwrap();
}

#[cfg(unix)]
struct FakeAiMemory {
    program: PathBuf,
    project_cwd: PathBuf,
}

#[cfg(unix)]
impl FakeAiMemory {
    fn new(root: &Path, pages: &[(&str, &str, &str, &str, &str)]) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let project_cwd = root.join("projeto-x");
        std::fs::create_dir_all(&project_cwd).unwrap();
        let store = root.join("aim-pages");
        std::fs::create_dir_all(&store).unwrap();

        let recent: Vec<_> = pages
            .iter()
            .map(|(path, title, _ws, _proj, _body)| {
                json!({
                    "path": path,
                    "title": title,
                    "snippet": title,
                    "updated_at": "2026-11-22T10:00:00Z"
                })
            })
            .collect();
        std::fs::write(store.join("recent.json"), serde_json::to_vec(&recent).unwrap()).unwrap();

        let mut pages_map = BTreeMap::new();
        for (path, title, ws, proj, body) in pages {
            let file_name = format!("{}.json", pages_map.len());
            std::fs::write(
                store.join(&file_name),
                serde_json::to_vec(&json!({
                    "path": path,
                    "workspace": ws,
                    "project": proj,
                    "title": title,
                    "body": body,
                    "frontmatter": { "title": title, "tier": "semantic" },
                    "expired": false
                }))
                .unwrap(),
            )
            .unwrap();
            pages_map.insert((*path).to_string(), file_name);
        }

        let mut case_arms = String::new();
        for (path, file_name) in pages_map {
            case_arms.push_str(&format!(
                "      \"{path}\") cat \"{}/{file_name}\" ;;\n",
                store.display()
            ));
        }

        let program = root.join("fake-ai-memory");
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "ai-memory 3.3.0"
  exit 0
fi
if [ "$1" = "recent" ]; then
  if [ "$AI_MEMORY_HOST_CWD" != "{cwd}" ]; then exit 77; fi
  cat "{store}/recent.json"
  exit 0
fi
if [ "$1" = "read-page" ]; then
  for arg in "$@"; do
    case "$arg" in
      --path=*) p="${{arg#--path=}}" ;;
    esac
  done
  case "$p" in
{case_arms}      *) echo 'Error: GET /admin/read-page: server returned 404 Not Found: {{}}' >&2; exit 1 ;;
  esac
  exit 0
fi
exit 99
"#,
            cwd = project_cwd.display(),
            store = store.display(),
            case_arms = case_arms,
        );
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self { program, project_cwd }
    }
}

#[tokio::test]
async fn nasce_desligado_e_desligado_nao_envia_nem_apaga_nada() {
    let root = TempRoot::new("disabled");
    let data = root.path().join("app-data");
    let bare = init_bare_remote(root.path(), "remote.git");
    let db = test_db_arc();
    approve_sqlite_memory(&db, "w1", "regra-1", "constraint", "Nunca usar panic em produção.", false);

    // 1. Nasce desligado por padrão.
    let initial = status_db(&db).unwrap();
    assert!(!initial.enabled);
    assert!(!initial.configured);
    assert!(!initial.auto_enabled);

    let forge = FakeForge::new();
    // Tentativa de envio antes de ligar não contacta o forge e não faz push.
    let err = sync_now_with(&db, &data, Some("w1"), None, None, &forge, None)
        .await
        .unwrap_err();
    assert!(err.to_lowercase().contains("desligad"), "{err}");
    assert_eq!(forge.find_calls.load(Ordering::SeqCst), 0);
    assert_eq!(remote_commit_count(&bare, "main"), 0);

    // 2. Configura privado, faz 1 envio e depois desliga:
    forge.insert_repo("ton/ade-memoria", true, &bare);
    let st = setup_with(&db, "acc1", "ton", ForgeKind::Github, &forge, "ade-memoria")
        .await
        .unwrap();
    assert!(st.enabled);
    assert!(st.configured);

    let res = sync_now_with(&db, &data, Some("w1"), None, None, &forge, None)
        .await
        .unwrap();
    assert!(res.report.pushed);
    let commits_before = remote_commit_count(&bare, "main");
    assert_eq!(commits_before, 1);
    assert!(mirror_dir(&data).join(".git").exists());

    // Desliga: para envios futuros e NÃO apaga espelho local, banco nem remoto.
    let off = set_enabled_db(&db, false).unwrap();
    assert!(!off.enabled);
    assert!(off.configured);
    assert!(mirror_dir(&data).join(".git").exists(), "desligar não apaga espelho local");

    approve_sqlite_memory(&db, "w1", "regra-2", "note", "Nota adicionada depois de desligar.", false);
    let calls_before = forge.find_calls.load(Ordering::SeqCst);
    let err_after = sync_now_with(&db, &data, Some("w1"), None, None, &forge, None)
        .await
        .unwrap_err();
    assert!(err_after.to_lowercase().contains("desligad"), "{err_after}");
    assert_eq!(forge.find_calls.load(Ordering::SeqCst), calls_before);
    assert_eq!(remote_commit_count(&bare, "main"), commits_before);
    // Banco local preservado:
    let count: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn recusa_repositorio_publico_no_setup_e_antes_de_enviar() {
    let root = TempRoot::new("public-repo");
    let data = root.path().join("app-data");
    let bare = init_bare_remote(root.path(), "publico.git");
    let db = test_db_arc();
    approve_sqlite_memory(&db, "w1", "regra", "note", "Conteúdo limpo.", false);

    let forge = FakeForge::new();
    forge.insert_repo("ton/ade-memoria", false, &bare);

    // 1. Setup recusa repositório público.
    let err = setup_with(&db, "acc1", "ton", ForgeKind::Github, &forge, "ade-memoria")
        .await
        .unwrap_err();
    assert!(err.to_lowercase().contains("público"), "{err}");
    assert!(!status_db(&db).unwrap().configured);

    // 2. Setup aceita privado, mas antes do envio o repositório vira público -> recusa e NÃO envia!
    forge.set_private("ton/ade-memoria", true);
    setup_with(&db, "acc1", "ton", ForgeKind::Github, &forge, "ade-memoria")
        .await
        .unwrap();
    forge.set_private("ton/ade-memoria", false);

    let err = sync_now_with(&db, &data, Some("w1"), None, None, &forge, None)
        .await
        .unwrap_err();
    assert!(err.to_lowercase().contains("público"), "{err}");
    assert_eq!(remote_commit_count(&bare, "main"), 0);
    assert!(status_db(&db).unwrap().last_error.is_some());

    // 3. Se não der para confirmar pela API (erro de rede / 404), NÃO envia e avisa!
    forge.set_private("ton/ade-memoria", true);
    forge.fail_find.store(true, Ordering::SeqCst);
    let err = sync_now_with(&db, &data, Some("w1"), None, None, &forge, None)
        .await
        .unwrap_err();
    assert!(err.contains("confirmar") || err.contains("privado"), "{err}");
    assert_eq!(remote_commit_count(&bare, "main"), 0);
}

#[tokio::test]
async fn api_real_confirma_privacidade_contra_http_falso_e_recusa_publico() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else { break };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let body = if req.contains("/repos/ton/publico") {
                json!({
                    "full_name": "ton/publico",
                    "private": false,
                    "fork": false,
                    "archived": false,
                    "clone_url": "https://github.com/ton/publico.git",
                    "html_url": "https://github.com/ton/publico",
                    "default_branch": "main"
                })
                .to_string()
            } else {
                json!({
                    "full_name": "ton/privado",
                    "private": true,
                    "fork": false,
                    "archived": false,
                    "clone_url": "https://github.com/ton/privado.git",
                    "html_url": "https://github.com/ton/privado",
                    "default_branch": "main"
                })
                .to_string()
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });

    let api = Api::with_base(ForgeKind::Github, format!("http://127.0.0.1:{port}"), "tok-teste").unwrap();
    let db = test_db_arc();
    let err = setup_with(&db, "acc1", "ton", ForgeKind::Github, &api, "publico")
        .await
        .unwrap_err();
    assert!(err.to_lowercase().contains("público"), "{err}");

    let ok = setup_with(&db, "acc1", "ton", ForgeKind::Github, &api, "privado")
        .await
        .unwrap();
    assert!(ok.configured);
    assert_eq!(ok.repo.as_deref(), Some("ton/privado"));
    server.join().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn filtra_segredo_no_ai_memory_e_sqlite_e_lista_paginas_puladas() {
    let root = TempRoot::new("secrets");
    let data = root.path().join("app-data");
    let bare = init_bare_remote(root.path(), "remote.git");
    let db = test_db_arc();

    let fake_token = format!("{}{}", "sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz012345");
    let fake_gh_token = format!("{}{}", "ghp_", "1234567890abcdefghijklmnopqrstuvwxyz");
    let secret_body = format!("Chave vazada: {fake_token}");
    let sqlite_secret_body = format!("Token antigo: {fake_gh_token}");

    // SQLite legado: 1 política de senha válida, 1 limpa e 1 com credencial confirmada localmente.
    approve_sqlite_memory(
        &db,
        "w1",
        "politica-senha",
        "constraint",
        "A senha deve ter no mínimo 12 caracteres",
        false,
    );
    approve_sqlite_memory(&db, "w1", "arquitetura", "decision", "Usamos Tauri 2 e React 19.", false);
    approve_sqlite_memory(&db, "w1", "credencial-antiga", "note", &sqlite_secret_body, true);

    // ai-memory: 1 página limpa, 1 com segredo, 1 de escopo _global (não deve vazar no escopo de projeto).
    let aim = FakeAiMemory::new(
        root.path(),
        &[
            ("notes/clean.md", "Guia limpo", "default", "projeto-x", "Preferir testes unitários determinísticos."),
            ("notes/leak.md", "Nota com segredo", "default", "projeto-x", &secret_body),
            ("notes/global.md", "Global", "_global", "_global", "Conteúdo global que não pertence ao projeto."),
        ],
    );

    let forge = FakeForge::new();
    forge.insert_repo("ton/ade-memoria", true, &bare);
    setup_with(&db, "acc1", "ton", ForgeKind::Github, &forge, "ade-memoria")
        .await
        .unwrap();

    let res = sync_now_with(
        &db,
        &data,
        Some("w1"),
        Some(aim.project_cwd.to_str().unwrap()),
        Some(aim.program.clone()),
        &forge,
        None,
    )
    .await
    .unwrap();

    assert!(res.report.pushed);
    assert_eq!(res.report.ai_memory_pages, 1);
    assert_eq!(res.report.sqlite_entries, 2);
    assert_eq!(res.report.skipped_pages.len(), 2, "{:?}", res.report.skipped_pages);
    assert!(res.report.skipped_pages.iter().any(|p| p.source == "ai-memory" && p.path == "notes/leak.md"));
    assert!(res.report.skipped_pages.iter().any(|p| p.source == "sqlite" && p.path.contains("credencial-antiga")));

    let files = remote_tree_files(&bare, "main");
    let joined: String = files.values().cloned().collect::<Vec<_>>().join("\n");
    assert!(files.contains_key("ai-memory/default/projeto-x/notes/clean.md"), "{:?}", files.keys());
    assert!(!files.contains_key("ai-memory/default/projeto-x/notes/leak.md"));
    assert!(!joined.contains(&fake_token), "segredo do ai-memory não pode ir ao remoto");
    assert!(!joined.contains(&fake_gh_token), "segredo do sqlite não pode ir ao remoto");
    assert!(!joined.contains("Conteúdo global"), "página _global deve ficar fora do escopo de projeto");
    assert!(joined.contains("A senha deve ter no mínimo 12 caracteres"), "frase de política deve passar");
    assert!(joined.contains("Usamos Tauri 2 e React 19."));

    // SQLite antigo permanece somente leitura (as 3 entradas seguem lá, intactas).
    let entries_count: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0)).unwrap();
    assert_eq!(entries_count, 3);
}

#[test]
fn token_nao_aparece_em_argv_nem_em_env_e_chega_por_askpass_efemero() {
    let root = TempRoot::new("cred");
    let token = "ghp_TokenSuperSecretoNaoVazar1234567890";
    let token_b64 = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let helper_path = root.path().join("ags");
    std::fs::write(&helper_path, "").unwrap();

    let (spec, askpass) = build_network_git_spec(
        root.path(),
        &["push", "-q", "origin", "HEAD:refs/heads/main"],
        Some(RemoteCredentials {
            host: "github.com",
            git_user: "x-access-token",
            token,
            helper_exe: &helper_path,
        }),
    )
    .unwrap();
    let askpass = askpass.expect("askpass efêmero deve estar ativo");

    // 1. Token (e sua forma base64) NUNCA aparecem em argv nem em env.
    for arg in &spec.args {
        assert!(!arg.contains(token), "token em argv: {arg}");
        assert!(!arg.contains(&token_b64), "token b64 em argv: {arg}");
    }
    for (k, v) in &spec.env {
        assert!(!k.contains(token) && !v.contains(token), "token em env {k}");
        assert!(!v.contains(&token_b64), "token b64 em env {k}");
    }
    assert!(spec.env.iter().any(|(k, _)| k == "GIT_ASKPASS"));

    // 2. Roundtrip pelo loopback entrega usuário e senha apenas ao host esperado e rejeita nonce/host inválido.
    let addr = askpass.addr().to_string();
    let nonce = askpass.nonce().to_string();
    let u = fetch_credential_over_loopback(&addr, &nonce, "Username for 'https://github.com': ", "github.com").unwrap();
    assert_eq!(u.0, "x-access-token");
    let p = fetch_credential_over_loopback(&addr, &nonce, "Password for 'https://x-access-token@github.com': ", "github.com").unwrap();
    assert_eq!(p.0, token);
    assert!(fetch_credential_over_loopback(&addr, "nonce-errado", "Password for 'https://github.com': ", "github.com").is_err());
    assert!(fetch_credential_over_loopback(&addr, &nonce, "Password for 'https://evil.example': ", "github.com").is_err());
}

#[cfg(unix)]
#[test]
fn git_real_usa_askpass_efemero_contra_servidor_http_sem_token_no_env() {
    use std::os::unix::fs::PermissionsExt;
    let root = TempRoot::new("git-http-askpass");
    let token = "tok_ephemeral_git_test_999";

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen_auth = Arc::new(Mutex::new(Vec::new()));
    let seen_clone = seen_auth.clone();
    let server = std::thread::spawn(move || {
        for _ in 0..3 {
            let Ok((mut stream, _)) = listener.accept() else { break };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let auth = req
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                .map(|l| l.to_string());
            let had_auth = auth.is_some();
            seen_clone.lock().unwrap().push(auth);
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            if had_auth {
                break;
            }
        }
    });

    // Helper script de teste sem o token em disco: lê apenas o endereço/nonce do env e consulta o loopback.
    let helper = root.path().join("askpass-test.sh");
    std::fs::write(
        &helper,
        r#"#!/bin/sh
kind="pass"
case "$1" in Username*) kind="user" ;; esac
python3 -c 'import os,sys,socket
host,port = os.environ["ADE_MEMSYNC_ASKPASS_ADDR"].split(":")
s = socket.create_connection((host, int(port)), timeout=2)
s.sendall((os.environ["ADE_MEMSYNC_ASKPASS_NONCE"] + " " + sys.argv[1] + "\n").encode())
data = s.recv(4096).decode().rstrip("\n")
print(data)
' "$kind"
"#,
    )
    .unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();

    let askpass = EphemeralAskpass::start("127.0.0.1", "x-access-token", token).unwrap();
    let env = askpass.env_vars(&helper);
    for (k, v) in &env {
        assert!(!v.contains(token), "token não pode estar em env {k}");
    }

    let out = std::process::Command::new("git")
        .args(["ls-remote", &format!("http://127.0.0.1:{port}/ton/mem.git")])
        .envs(env)
        .output()
        .unwrap();
    assert!(!out.status.success());
    drop(askpass);
    server.join().unwrap();

    let expected = format!(
        "authorization: basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
    );
    let headers = seen_auth.lock().unwrap();
    assert!(
        headers
            .iter()
            .flatten()
            .any(|h| h.to_ascii_lowercase() == expected),
        "git deveria enviar credencial vinda do askpass efêmero: {headers:?}"
    );
}

#[tokio::test]
async fn nao_mexe_no_repositorio_local_de_projecao_nem_apaga_outros_projetos_no_remoto() {
    let root = TempRoot::new("isolated-mirror");
    let data = root.path().join("app-data");
    let local_memory_root = root.path().join("ags-memory");
    let bare = init_bare_remote(root.path(), "remote.git");

    // Prepara repositório remoto já com conteúdo de outro projeto e verifica que não é apagado.
    let seed = root.path().join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    run_git(&seed, &["clone", "-q", bare.to_str().unwrap(), "."]);
    std::fs::create_dir_all(seed.join("ai-memory/default/outro-repo/notes")).unwrap();
    std::fs::write(seed.join("ai-memory/default/outro-repo/notes/keep.md"), "Manter outro projeto").unwrap();
    run_git(&seed, &["add", "-A"]);
    run_git(&seed, &["commit", "-q", "-m", "outro projeto"]);
    run_git(&seed, &["push", "-q", "origin", "HEAD:refs/heads/main"]);

    let db = test_db_arc();
    approve_sqlite_memory(&db, "w1", "local", "note", "Memória para projeção local.", false);

    // Exporta projeção local (deve continuar sem remote!).
    let exported = crate::memory::repo::export_at(&db.lock().unwrap(), "w1", &local_memory_root, None).unwrap();
    let local_repo = PathBuf::from(&exported.path);
    assert!(run_git(&local_repo, &["remote"]).is_empty());

    let forge = FakeForge::new();
    forge.insert_repo("ton/ade-memoria", true, &bare);
    setup_with(&db, "acc1", "ton", ForgeKind::Github, &forge, "ade-memoria")
        .await
        .unwrap();
    set_auto_db(&db, true, 12).unwrap();
    assert_eq!(status_db(&db).unwrap().interval_hours, 12);

    sync_now_with(&db, &data, Some("w1"), None, None, &forge, None)
        .await
        .unwrap();

    // O repositório local de projeção continua sem nenhum remote e funcionando!
    assert!(run_git(&local_repo, &["remote"]).is_empty());
    crate::memory::repo::export_at(&db.lock().unwrap(), "w1", &local_memory_root, None).unwrap();

    // O arquivo de outro projeto no remoto foi preservado (mão única por escopo).
    let remote_files = remote_tree_files(&bare, "main");
    assert_eq!(
        remote_files.get("ai-memory/default/outro-repo/notes/keep.md").map(String::as_str),
        Some("Manter outro projeto")
    );
}
