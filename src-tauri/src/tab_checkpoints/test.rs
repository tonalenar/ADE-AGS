use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use super::git;
use super::lock::{blockers, normalize, overlaps};
use super::service::{self, first_line, Capture, Request};
use super::store::{self, kind, MAX_PER_TAB};
use crate::database::DbConnection;

struct Tmp(PathBuf);
impl Tmp {
    fn new(name: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("ags-tabcp-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&p).unwrap();
        // O `show-toplevel` do git devolve o caminho canônico (sem 8.3 nem symlink do /tmp).
        Tmp(dunce::canonicalize(&p).unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=ags-test", "-c", "user.email=ags@test", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .expect("git instalado");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> Tmp {
    let t = Tmp::new("repo");
    sh(&t.0, &["init", "-q", "-b", "main"]);
    std::fs::write(t.0.join(".gitignore"), "ignorado.log\n").unwrap();
    std::fs::write(t.0.join("a.txt"), "um\n").unwrap();
    std::fs::write(t.0.join("b.txt"), "dois\n").unwrap();
    sh(&t.0, &["add", "."]);
    sh(&t.0, &["commit", "-q", "-m", "inicio"]);
    t
}

fn read(dir: &Path, f: &str) -> Option<String> {
    // O git no Windows pode devolver CRLF conforme `core.autocrlf`: o que importa é o conteúdo.
    std::fs::read_to_string(dir.join(f)).ok().map(|c| c.replace("\r\n", "\n"))
}

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

fn req<'a>(tab: &'a str, cwd: &'a Path, message: &'a str) -> Request<'a> {
    Request { tab_id: tab, cwd, kind: kind::MESSAGE, author: "pessoa", message, force: false }
}

fn created(c: Capture) -> store::TabCheckpoint {
    match c {
        Capture::Created { checkpoint } => checkpoint,
        other => panic!("esperava um ponto novo, veio {other:?}"),
    }
}

// ── Tirar a foto ────────────────────────────────────────────────

#[test]
fn a_foto_nao_toca_indice_branch_stash_nem_arquivos() {
    let r = repo();
    let db = db();
    std::fs::write(r.0.join("a.txt"), "um mudado\n").unwrap();
    std::fs::write(r.0.join("b.txt"), "dois preparado\n").unwrap();
    sh(&r.0, &["add", "b.txt"]);
    std::fs::write(r.0.join("novo.txt"), "novo\n").unwrap();
    sh(&r.0, &["stash", "list"]);
    let status = sh(&r.0, &["status", "--porcelain"]);
    let head = sh(&r.0, &["rev-parse", "HEAD"]);
    let branch = sh(&r.0, &["symbolic-ref", "HEAD"]);
    let staged = sh(&r.0, &["diff", "--cached", "--name-only"]);

    let cp = created(service::capture(&db, &req("tab-1", &r.0, "corrige o login\nsegunda linha")).unwrap());

    assert_eq!(sh(&r.0, &["status", "--porcelain"]), status, "o estado não mudou");
    assert_eq!(sh(&r.0, &["rev-parse", "HEAD"]), head);
    assert_eq!(sh(&r.0, &["symbolic-ref", "HEAD"]), branch);
    assert_eq!(sh(&r.0, &["diff", "--cached", "--name-only"]), staged, "o índice continua igual");
    assert_eq!(sh(&r.0, &["stash", "list"]), "");
    // A foto leva o modificado, o preparado e o novo, com o HEAD como pai, numa ref escondida.
    assert_eq!(sh(&r.0, &["show", &format!("{}:a.txt", cp.commit_sha)]), "um mudado");
    assert_eq!(sh(&r.0, &["show", &format!("{}:b.txt", cp.commit_sha)]), "dois preparado");
    assert_eq!(sh(&r.0, &["show", &format!("{}:novo.txt", cp.commit_sha)]), "novo");
    assert_eq!(sh(&r.0, &["rev-parse", &format!("{}^", cp.commit_sha)]), head);
    assert_eq!(cp.ref_name, "refs/ags/checkpoints/tab-1/1");
    assert_eq!(sh(&r.0, &["rev-parse", &cp.ref_name]), cp.commit_sha);
    // A ficha: primeira linha, quem mandou; o texto da pessoa não vai para o commit.
    assert_eq!(cp.message, "corrige o login");
    assert_eq!(cp.author, "pessoa");
    assert!(!sh(&r.0, &["log", "-1", "--format=%B", &cp.commit_sha]).contains("login"));
    // Sem restos do índice temporário.
    let leftovers: Vec<_> = std::fs::read_dir(r.0.join(".git"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("ags-checkpoint"))
        .collect();
    assert!(leftovers.is_empty());
    // A ref escondida não aparece entre as branches.
    assert!(!sh(&r.0, &["branch", "--list"]).contains("checkpoint"));
}

#[test]
fn sem_mudanca_desde_o_ultimo_nao_cria_outro() {
    let r = repo();
    let db = db();
    let first = created(service::capture(&db, &req("t", &r.0, "1")).unwrap());
    match service::capture(&db, &req("t", &r.0, "2")).unwrap() {
        Capture::Unchanged { checkpoint } => assert_eq!(checkpoint.id, first.id),
        other => panic!("{other:?}"),
    }
    // Mudar só um arquivo ignorado também não conta.
    std::fs::write(r.0.join("ignorado.log"), "x").unwrap();
    assert!(matches!(service::capture(&db, &req("t", &r.0, "3")).unwrap(), Capture::Unchanged { .. }));
    std::fs::write(r.0.join("a.txt"), "outro\n").unwrap();
    let second = created(service::capture(&db, &req("t", &r.0, "4")).unwrap());
    assert_eq!(second.seq, 2);
    assert_eq!(service::list(&db, "t").unwrap().len(), 2);
}

#[test]
fn pasta_que_nao_e_repositorio_nao_tem_ponto() {
    let t = Tmp::new("solta");
    let db = db();
    assert_eq!(service::capture(&db, &req("t", &t.0, "oi")).unwrap(), Capture::NotRepo);
    assert!(service::list(&db, "t").unwrap().is_empty());
}

#[test]
fn repositorio_sem_nenhum_commit_tambem_tem_ponto() {
    let t = Tmp::new("vazio");
    sh(&t.0, &["init", "-q", "-b", "main"]);
    std::fs::write(t.0.join("x.txt"), "x\n").unwrap();
    let db = db();
    let cp = created(service::capture(&db, &req("t", &t.0, "primeira")).unwrap());
    assert_eq!(cp.head_sha, None);
    assert_eq!(sh(&t.0, &["show", &format!("{}:x.txt", cp.commit_sha)]), "x");
    assert!(sh(&t.0, &["status", "--porcelain"]).contains("?? x.txt"), "o arquivo segue sem rastrear");
}

#[test]
fn a_foto_de_uma_subpasta_cobre_o_repositorio_inteiro() {
    let r = repo();
    std::fs::create_dir_all(r.0.join("pkg")).unwrap();
    std::fs::write(r.0.join("a.txt"), "de fora da subpasta\n").unwrap();
    let db = db();
    let cp = created(service::capture(&db, &req("t", &r.0.join("pkg"), "m")).unwrap());
    assert_eq!(Path::new(&cp.repo_root), r.0.as_path());
    assert_eq!(sh(&r.0, &["show", &format!("{}:a.txt", cp.commit_sha)]), "de fora da subpasta");
}

#[test]
fn crlf_com_autocrlf_ligado_nao_quebra_a_foto_nem_a_volta() {
    let r = repo();
    sh(&r.0, &["config", "core.autocrlf", "true"]);
    sh(&r.0, &["config", "core.safecrlf", "true"]);
    // Fim de linha misto: com `safecrlf=true` o `git add` normal recusaria.
    std::fs::write(r.0.join("misto.txt"), "um\r\ndois\nhum\r\n").unwrap();
    let db = db();
    let cp = created(service::capture(&db, &req("t", &r.0, "m")).unwrap());
    std::fs::remove_file(r.0.join("misto.txt")).unwrap();
    let out = service::restore(&db, &cp.id, false, &[], &[]).unwrap();
    assert!(out.report.unwrap().failed.is_empty());
    assert!(read(&r.0, "misto.txt").unwrap().contains("dois"));
}

// ── Voltar ──────────────────────────────────────────────────────

#[test]
fn voltar_reescreve_os_arquivos_sem_mexer_no_head_nem_no_ignorado_e_e_desfazivel() {
    let r = repo();
    let db = db();
    // O estado do ponto: a.txt editado sem commit, c.txt novo.
    std::fs::write(r.0.join("a.txt"), "um no ponto\n").unwrap();
    std::fs::write(r.0.join("c.txt"), "c do ponto\n").unwrap();
    let cp = created(service::capture(&db, &req("t", &r.0, "antes do agente")).unwrap());

    // Depois: o agente edita, apaga, cria, commita; e há coisa ignorada.
    std::fs::write(r.0.join("a.txt"), "um quebrado\n").unwrap();
    std::fs::remove_file(r.0.join("b.txt")).unwrap();
    std::fs::remove_file(r.0.join("c.txt")).unwrap();
    std::fs::create_dir_all(r.0.join("sub/fundo")).unwrap();
    std::fs::write(r.0.join("sub/fundo/e.txt"), "e\n").unwrap();
    sh(&r.0, &["add", "-A"]);
    sh(&r.0, &["commit", "-q", "-m", "o agente commitou"]);
    std::fs::write(r.0.join("d.txt"), "d novo sem rastrear\n").unwrap();
    std::fs::write(r.0.join("ignorado.log"), "não mexe\n").unwrap();
    let head = sh(&r.0, &["rev-parse", "HEAD"]);

    let out = service::restore(&db, &cp.id, false, &[], &[]).unwrap();
    assert!(out.blockers.is_empty());
    let report = out.report.unwrap();
    assert!(report.failed.is_empty(), "{report:?}");

    assert_eq!(sh(&r.0, &["rev-parse", "HEAD"]), head, "o HEAD e a branch ficam onde estão");
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("um no ponto\n"));
    assert_eq!(read(&r.0, "b.txt").as_deref(), Some("dois\n"), "o apagado volta");
    assert_eq!(read(&r.0, "c.txt").as_deref(), Some("c do ponto\n"));
    assert!(read(&r.0, "d.txt").is_none(), "o que nasceu depois sai");
    assert!(!r.0.join("sub").exists(), "a pasta que ficou vazia sai");
    assert_eq!(read(&r.0, "ignorado.log").as_deref(), Some("não mexe\n"), "o ignorado não muda");

    // A foto de segurança guarda o de antes: voltar a ela desfaz a restauração.
    let safety = out.safety.unwrap();
    assert_eq!(safety.kind, kind::SAFETY);
    assert_eq!(safety.seq, 2);
    let undo = service::restore(&db, &safety.id, false, &[], &[]).unwrap();
    assert!(undo.report.unwrap().failed.is_empty());
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("um quebrado\n"));
    assert_eq!(read(&r.0, "d.txt").as_deref(), Some("d novo sem rastrear\n"));
    assert_eq!(read(&r.0, "sub/fundo/e.txt").as_deref(), Some("e\n"));
    assert!(read(&r.0, "c.txt").is_none());
    // O conteúdo é o de antes. (O `status` pode listar a.txt como modificado só pelo CRLF que o
    // `core.autocrlf` do Windows põe ao escrever; o conteúdo no git é o mesmo.)
    sh(&r.0, &["add", "-A"]);
    assert_eq!(sh(&r.0, &["status", "--porcelain"]), "A  d.txt", "de volta ao estado exato");
}

#[test]
fn voltar_nao_mexe_no_indice_da_pessoa() {
    let r = repo();
    let db = db();
    let cp = created(service::capture(&db, &{
        std::fs::write(r.0.join("a.txt"), "versao do ponto\n").unwrap();
        req("t", &r.0, "m")
    }).unwrap());
    std::fs::write(r.0.join("b.txt"), "preparado depois\n").unwrap();
    sh(&r.0, &["add", "b.txt"]);
    let staged_blob = sh(&r.0, &["rev-parse", ":b.txt"]);
    service::restore(&db, &cp.id, false, &[], &[]).unwrap();
    assert_eq!(sh(&r.0, &["rev-parse", ":b.txt"]), staged_blob, "o preparado continua preparado");
    assert_eq!(read(&r.0, "b.txt").as_deref(), Some("dois\n"), "o arquivo no disco voltou");
}

#[test]
fn voltar_com_outra_aba_na_mesma_pasta_recusa_ate_forcar() {
    let r = repo();
    let db = db();
    std::fs::write(r.0.join("a.txt"), "ponto\n").unwrap();
    let cp = created(service::capture(&db, &req("eu", &r.0, "m")).unwrap());
    std::fs::write(r.0.join("a.txt"), "trabalho da outra aba\n").unwrap();
    let root = r.0.to_string_lossy().to_string();
    let sub = r.0.join("pkg").to_string_lossy().to_string();
    let tabs = vec![("eu".to_string(), root.clone()), ("outra".to_string(), sub)];

    let out = service::restore(&db, &cp.id, false, &tabs, &[]).unwrap();
    assert_eq!(out.blockers.len(), 1);
    assert_eq!(out.blockers[0].id, "outra");
    assert!(out.safety.is_none() && out.report.is_none(), "nada foi feito");
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("trabalho da outra aba\n"));
    assert_eq!(service::list(&db, "eu").unwrap().len(), 1, "nem a foto de segurança");

    let forced = service::restore(&db, &cp.id, true, &tabs, &[]).unwrap();
    assert!(forced.safety.is_some());
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("ponto\n"));
}

#[test]
fn voltar_a_um_ponto_cuja_foto_sumiu_falha_sem_tocar_nada() {
    let r = repo();
    let db = db();
    std::fs::write(r.0.join("a.txt"), "x\n").unwrap();
    let cp = created(service::capture(&db, &req("t", &r.0, "m")).unwrap());
    {
        let conn = db.lock().unwrap();
        conn.execute("UPDATE tab_checkpoints SET commit_sha = '0123456789012345678901234567890123456789' WHERE id = ?1", [&cp.id])
            .unwrap();
    }
    std::fs::write(r.0.join("a.txt"), "agora\n").unwrap();
    let err = service::restore(&db, &cp.id, false, &[], &[]).unwrap_err();
    assert!(err.contains("não está mais"), "{err}");
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("agora\n"));
    assert_eq!(service::list(&db, "t").unwrap().len(), 1, "sem foto de segurança à toa");
}

#[cfg(windows)]
#[test]
fn arquivo_travado_entra_na_foto_automatica_como_estava_e_impede_a_volta() {
    use std::os::windows::fs::OpenOptionsExt;
    let r = repo();
    let db = db();
    std::fs::write(r.0.join("a.txt"), "ponto a\n").unwrap();
    std::fs::write(r.0.join("b.txt"), "ponto b\n").unwrap();
    let cp = created(service::capture(&db, &req("t", &r.0, "m")).unwrap());
    std::fs::write(r.0.join("a.txt"), "depois a\n").unwrap();
    std::fs::write(r.0.join("b.txt"), "depois b\n").unwrap();
    // Sem compartilhamento: ninguém mais abre o arquivo enquanto este handle vive.
    let lock = std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(r.0.join("a.txt")).unwrap();

    // A foto automática não falha por causa dele: o resto entra.
    let auto = created(service::capture(&db, &req("t", &r.0, "m2")).unwrap());
    assert_eq!(sh(&r.0, &["show", &format!("{}:b.txt", auto.commit_sha)]), "depois b");

    // Voltar recusa sem mexer em nada: a foto de segurança não guardaria o a.txt de agora.
    let err = service::restore(&db, &cp.id, false, &[], &[]).unwrap_err();
    drop(lock);
    assert!(err.contains("a.txt") && err.contains("outro programa"), "{err}");
    assert_eq!(read(&r.0, "b.txt").as_deref(), Some("depois b\n"));
    assert_eq!(service::list(&db, "t").unwrap().len(), 2, "sem foto de segurança");
}

#[test]
fn reconhece_quando_o_add_so_falhou_por_arquivo_travado() {
    let locked = "warning: in the working copy of 'x', LF will be replaced by CRLF\nerror: open(\"a b.txt\"): Permission denied\nerror: unable to index file 'a b.txt'\nfatal: updating files failed";
    assert_eq!(git::unreadable_files(locked), Some(vec!["a b.txt".to_string()]));
    assert_eq!(git::unreadable_files("fatal: index file corrupt"), None);
    assert_eq!(git::unreadable_files(""), None);
}

// ── Diff ────────────────────────────────────────────────────────

#[test]
fn o_diff_desde_o_ponto_mostra_o_que_mudou_ate_agora() {
    let r = repo();
    let db = db();
    let cp = created(service::capture(&db, &{
        std::fs::write(r.0.join("a.txt"), "antes\n").unwrap();
        req("t", &r.0, "m")
    }).unwrap());
    std::fs::write(r.0.join("a.txt"), "depois\n").unwrap();
    std::fs::write(r.0.join("novo.txt"), "n\n").unwrap();
    let d = service::diff_since(&db, &cp.id).unwrap();
    assert!(d.stat.contains("a.txt") && d.stat.contains("novo.txt"), "{}", d.stat);
    assert!(d.patch.contains("-antes") && d.patch.contains("+depois"), "{}", d.patch);
    assert!(!d.truncated);
    assert!(sh(&r.0, &["status", "--porcelain"]).contains("?? novo.txt"), "o diff não preparou nada");
}

// ── Limpeza ─────────────────────────────────────────────────────

#[test]
fn cada_aba_guarda_no_maximo_o_teto_e_solta_as_refs_velhas() {
    let r = repo();
    let db = db();
    let mut first_ref = String::new();
    for i in 0..(MAX_PER_TAB + 2) {
        std::fs::write(r.0.join("a.txt"), format!("versão {i}\n")).unwrap();
        let cp = created(service::capture(&db, &req("t", &r.0, "m")).unwrap());
        if i == 0 {
            first_ref = cp.ref_name.clone();
        }
    }
    let list = service::list(&db, "t").unwrap();
    assert_eq!(list.len() as i64, MAX_PER_TAB);
    assert_eq!(list[0].seq, MAX_PER_TAB + 2, "o mais novo primeiro");
    assert_eq!(list.last().unwrap().seq, 3);
    let refs = sh(&r.0, &["for-each-ref", "--format=%(refname)", "refs/ags/checkpoints/t/"]);
    assert_eq!(refs.lines().count() as i64, MAX_PER_TAB);
    assert!(!refs.lines().any(|l| l == first_ref));
}

#[test]
fn apagar_os_pontos_da_aba_solta_fichas_e_refs() {
    let r = repo();
    let db = db();
    created(service::capture(&db, &req("t", &r.0, "m")).unwrap());
    created(service::capture(&db, &req("outra", &r.0, "m")).unwrap());
    assert_eq!(service::remove_tab(&db, "t").unwrap(), 1);
    assert!(service::list(&db, "t").unwrap().is_empty());
    assert_eq!(sh(&r.0, &["for-each-ref", "--format=%(refname)", "refs/ags/checkpoints/"]), "refs/ags/checkpoints/outra/1");
}

#[test]
fn limpar_tira_so_as_abas_fechadas_de_vez() {
    let r = repo();
    let db = db();
    for tab in ["salva", "viva", "fechada", "recente"] {
        created(service::capture(&db, &req(tab, &r.0, "m")).unwrap());
    }
    let now = crate::util::now_ts_ms();
    {
        let conn = db.lock().unwrap();
        // Tudo é velho, menos a "recente" (que talvez ainda não foi salva em `tabs`).
        conn.execute("UPDATE tab_checkpoints SET created_at = ?1 WHERE tab_id != 'recente'", [now - 3_600_000]).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'w', 0, 0);
             INSERT INTO windows (id, label, workspace_id, last_active) VALUES ('win', 'main', 'w', 0);
             INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
                 VALUES ('salva', 'win', 'bash', 'bash', 'bash', '.', 0, 0, 0);",
        )
        .unwrap();
    }
    assert_eq!(service::prune(&db, &["viva".into()], now).unwrap(), 1);
    for (tab, kept) in [("salva", true), ("viva", true), ("fechada", false), ("recente", true)] {
        assert_eq!(!service::list(&db, tab).unwrap().is_empty(), kept, "{tab}");
    }
    assert!(!sh(&r.0, &["for-each-ref", "--format=%(refname)"]).contains("/fechada/"));
}

#[test]
fn a_migracao_e_idempotente() {
    let conn = crate::database::test_db();
    super::store::migrate(&conn).unwrap();
    super::store::migrate(&conn).unwrap();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM tab_checkpoints", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

// ── Puras ───────────────────────────────────────────────────────

#[test]
fn a_trava_de_pasta_ve_a_mesma_pasta_as_de_dentro_e_as_de_fora() {
    assert!(overlaps("C:\\Repo", "c:/repo/"));
    assert!(overlaps("/home/a/repo", "/home/a/repo/src"));
    assert!(overlaps("/home/a/repo/src", "/home/a/repo"));
    assert!(overlaps("/home/a", "/home/a/repo"), "uma pasta mãe também usa o repositório");
    assert!(!overlaps("/home/a/repo", "/home/a/repo-2"), "prefixo não é pasta");
    assert!(!overlaps("/home/a/repo", ""));
    assert_eq!(normalize("\\\\?\\C:\\X\\"), "c:/x");

    let tabs = vec![
        ("eu".to_string(), "/r".to_string()),
        ("vizinha".to_string(), "/r/pkg".to_string()),
        ("longe".to_string(), "/outro".to_string()),
        ("vizinha".to_string(), "/r".to_string()),
    ];
    let tasks = vec![("tarefa".to_string(), "/r".to_string()), ("isolada".to_string(), "/wt/x".to_string())];
    let b = blockers("/r", "eu", &tabs, &tasks);
    let ids: Vec<_> = b.iter().map(|b| (b.kind.as_str(), b.id.as_str())).collect();
    assert_eq!(ids, vec![("tab", "vizinha"), ("task", "tarefa")]);
}

#[test]
fn primeira_linha_e_nome_de_ref_seguros() {
    assert_eq!(first_line("\n\n  oi  \nresto", 140), "oi");
    assert_eq!(first_line("", 10), "");
    assert_eq!(first_line("ãããããããããããã", 5), "ãããã…");
    assert_eq!(git::scope_of("tab 1/../x"), "tab_1____x");
    assert_eq!(git::ref_name("", 3), "refs/ags/checkpoints/_/3");
}

#[test]
fn le_o_diff_cru_com_modos_e_caminhos_com_espaco() {
    let raw = b":100644 100644 aaa bbb M\0dir/a b.txt\0:000000 100644 000 ccc A\0novo\0:160000 000000 ddd 000 D\0sub\0";
    let changes = git::parse_raw_diff(raw);
    assert_eq!(changes.len(), 3);
    assert_eq!(changes[0].path, "dir/a b.txt");
    assert_eq!(changes[1].status, 'A');
    assert_eq!(changes[2].old_mode, "160000");
    let lotes = git::batches(&["aaaa".into(), "bbbb".into(), "cccc".into()], 10);
    assert_eq!(lotes.len(), 2);
}
