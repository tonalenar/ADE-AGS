use super::*;
use crate::memory::{ProposalActor, ProposalInput};

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path=std::env::temp_dir().join(format!("ade-memory-repo-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();Self(path)
    }
    fn path(&self)->&Path { &self.0 }
}
impl Drop for TempDir {
    fn drop(&mut self) { let _=std::fs::remove_dir_all(&self.0); }
}

fn fixture() -> Connection {
    let c=crate::database::test_db();
    c.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','Test workspace',0,0);
        INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('m','w','Mission','objective','/test',0,0);
        INSERT INTO runs(id,workspace_id,mission_id,objective,cwd,created_at) VALUES('run','w','m','objective','/test',0);").unwrap();
    c
}

#[test]
fn approved_reader_rejects_traversal_and_keeps_pending_and_other_missions_out() {
    let c=fixture();
    c.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('other','w','Other','x','/test',0,0)",[]).unwrap();
    let input=|scope:&str,key:&str,body:&str| ProposalInput{scope:scope.into(),key:key.into(),kind:"note".into(),body:body.into(),priority:0,operation:"create".into(),expected_revision:None,source_fact_id:None,reason:None,acknowledge_secret:false};
    let actor=||ProposalActor{kind:"user",run_id:None,task_id:None,fact_id:None};
    super::super::propose(&c,"workspace","w",None,&input("workspace","pending","hidden pending"),actor()).unwrap();
    let other=super::super::propose(&c,"mission","w",Some("other"),&input("mission","private","other mission data"),actor()).unwrap();
    super::super::decide(&c,&other.entry_id,other.revision,true).unwrap();
    let approved=super::super::propose(&c,"workspace","w",None,&input("workspace","safe","visible ``` <tag>"),actor()).unwrap();
    super::super::decide(&c,&approved.entry_id,approved.revision,true).unwrap();
    let text=approved_open(&c,"w",Some("m"),"notes.md").unwrap();
    assert!(text.contains("visible")); assert!(text.contains("UNTRUSTED"));
    let json=text.split("```json\n").nth(1).unwrap().split("\n```").next().unwrap();
    let value:serde_json::Value=serde_json::from_str(json).unwrap();assert!(value["content"].as_str().unwrap().contains("visible"));
    assert!(!text.contains("hidden pending"));assert!(!text.contains("other mission data"));assert!(!text.contains("<tag>"));
    for path in ["../notes.md","/notes.md","C:/notes.md","notes\\file.md",".git/config","missions/other.md"] {assert!(approved_open(&c,"w",Some("m"),path).is_err(),"{path}");}
}

fn propose(c:&Connection,key:&str,body:&str)->crate::memory::ProposalResult {
    crate::memory::propose(c,"workspace","w",None,&ProposalInput {
        scope:"workspace".into(),key:key.into(),kind:"constraint".into(),body:body.into(),priority:3,
        operation:"create".into(),expected_revision:None,source_fact_id:None,reason:None,
    
        acknowledge_secret: false,
},ProposalActor{kind:"user",run_id:None,task_id:None,fact_id:None}).unwrap()
}

#[test]
fn projection_is_approved_only_deterministic_and_local() {
    let c=fixture();let root=TempDir::new();
    let approved=propose(&c,"approved","One\nline of evidence");
    crate::memory::decide(&c,&approved.entry_id,approved.revision,true).unwrap();
    propose(&c,"pending","Pending material never exported");
    let rejected=propose(&c,"rejected","Rejected material never exported");
    crate::memory::decide(&c,&rejected.entry_id,rejected.revision,false).unwrap();
    crate::runs::store::add_fact(&c,"run",None,"finding","A run fact").unwrap();
    let first=render(&c,"w",&[]).unwrap();assert_eq!(first,render(&c,"w",&[]).unwrap());
    assert!(first["MEMORY.md"].lines().count()<=40);
    assert!(first["constraints.md"].contains("- One line of evidence [source: ags://run/manual/task/user; added:"));
    assert!(!first.values().any(|s|s.contains("Pending material")||s.contains("Rejected material")));
    assert!(first.keys().any(|s|s.starts_with("swarms/")&&s.ends_with("/findings.md")));
    let result=export_at(&c,"w",root.path(),Some((&approved.entry_id,1))).unwrap();
    let path=Path::new(&result.path);assert!(path.starts_with(root.path()));assert!(result.commit.is_some());
    for (file,body) in first { assert_eq!(std::fs::read_to_string(path.join(file)).unwrap(),body); }
    assert!(git(path,&["remote"]).unwrap().is_empty());
    assert!(export_at(&c,"w",root.path(),None).unwrap().commit.is_none());
}

fn propose_user(c:&Connection,key:&str,body:&str,acknowledge:bool)->crate::memory::ProposalResult {
    crate::memory::propose(c,"workspace","w",None,&ProposalInput {
        scope:"workspace".into(),key:key.into(),kind:"constraint".into(),body:body.into(),priority:3,
        operation:"create".into(),expected_revision:None,source_fact_id:None,reason:None,
        acknowledge_secret:acknowledge,
    },ProposalActor{kind:"user",run_id:None,task_id:None,fact_id:None}).unwrap()
}

#[test]
fn one_secret_does_not_block_export_of_the_other_entries() {
    let c=fixture();let temp=TempDir::new();let root=temp.path().join("repo");
    let policy=propose(&c,"politica-de-senha","senha: mínimo 12 caracteres");
    crate::memory::decide(&c,&policy.entry_id,policy.revision,true).unwrap();
    let err=crate::memory::propose(&c,"workspace","w",None,&ProposalInput {
        scope:"workspace".into(),key:"segredo".into(),kind:"note".into(),body:"password: hunter2".into(),priority:1,
        operation:"create".into(),expected_revision:None,source_fact_id:None,reason:None,acknowledge_secret:false,
    },ProposalActor{kind:"user",run_id:None,task_id:None,fact_id:None}).unwrap_err();
    assert!(err.contains("CONFIRMACAO_DE_CREDENCIAL"), "{err}");
    let legacy=propose_user(&c,"legado","password: hunter2",true);
    c.execute("DELETE FROM memory_secret_overrides WHERE entry_id=?1",[&legacy.entry_id]).unwrap();
    crate::memory::decide(&c,&legacy.entry_id,legacy.revision,true).unwrap();
    let stripe = format!("{}{}", "sk_", "live_abcdefghijklmnopqrstuvwxyz");
    c.execute("INSERT INTO run_facts(id,run_id,kind,body,created_at) VALUES('fact-secret','run','finding',?1,1)", [&stripe]).unwrap();
    let exported=export_at(&c,"w",&root,None).unwrap();
    assert!(root.join(slug("Test workspace","w")).exists());
    let files=render(&c,"w",&[]).unwrap();
    let joined=files.values().cloned().collect::<Vec<_>>().join("\n");
    assert!(joined.contains("senha: mínimo 12 caracteres"), "{joined}");
    assert!(!joined.contains("hunter2"), "{joined}");
    assert!(!joined.contains(&format!("{}{}", "sk_", "live_")), "{joined}");
    assert!(joined.contains("omitido: possível credencial"));
    assert!(exported.warnings.iter().any(|w| w.contains(&legacy.entry_id)));
    assert!(exported.warnings.iter().any(|w| w.contains("fact-secret")));
    let conscious=propose_user(&c,"consciente","password: hunter2-confirmed",true);
    crate::memory::decide(&c,&conscious.entry_id,conscious.revision,true).unwrap();
    let again=export_at(&c,"w",&root,Some((&conscious.entry_id,conscious.revision))).unwrap();
    let shown=std::fs::read_to_string(Path::new(&again.path).join("constraints.md")).unwrap();
    assert!(shown.contains("hunter2-confirmed"), "{shown}");
    assert!(shown.contains("mínimo 12 caracteres"), "{shown}");
    assert_eq!(shown.matches("hunter2").count(), 1, "{shown}");
}

#[test]
fn preview_overrides_are_pure_and_match_export_after_approval() {
    let c=fixture();let root=TempDir::new();let p=propose(&c,"new","New evidence");
    let before=render(&c,"w",&[]).unwrap();let preview=render(&c,"w",&[(p.entry_id.clone(),p.revision)]).unwrap();
    assert_ne!(before,preview);assert!(!root.path().join(slug("Test workspace","w")).exists());
    crate::memory::decide(&c,&p.entry_id,p.revision,true).unwrap();
    assert_eq!(preview,render(&c,"w",&[]).unwrap());
    let exported=export_at(&c,"w",root.path(),Some((&p.entry_id,p.revision))).unwrap();
    for (file,body) in preview {assert_eq!(git(Path::new(&exported.path),&["show",&format!("HEAD:{file}")]).unwrap(),body.trim_end());}
}

#[test]
fn git_recusa_rodar_com_o_mutex_do_banco_preso_nesta_thread() {
    let _hold = DbHoldGuard::enter();
    let err = run_git(Path::new("."), &["status".to_string()]).unwrap_err();
    assert!(err.contains("mutex do banco"), "{err}");
    let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = std::sync::Arc::clone(&called);
    let runner: GitRunner = std::sync::Arc::new(move |_path, _args| {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(String::new())
    });
    let err = match publish(Path::new("."), "Nome", "w", &Files::new(), &BTreeSet::new(), None, 0, &runner) {
        Err(error) => error,
        Ok(_) => panic!("publish deveria recusar git com o banco preso"),
    };
    assert!(err.contains("mutex do banco"), "{err}");
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst), "publish chamou git com o banco preso");
}
