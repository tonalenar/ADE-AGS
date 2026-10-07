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

fn propose(c:&Connection,key:&str,body:&str)->crate::memory::ProposalResult {
    crate::memory::propose(c,"workspace","w",None,&ProposalInput {
        scope:"workspace".into(),key:key.into(),kind:"constraint".into(),body:body.into(),priority:3,
        operation:"create".into(),expected_revision:None,source_fact_id:None,reason:None,
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

#[test]
fn secret_preflight_prevents_even_directory_creation() {
    let c=fixture();let temp=TempDir::new();let root=temp.path().join("never-created");
    let secret=propose(&c,"legacy-secret","password: example-value");
    crate::memory::decide(&c,&secret.entry_id,secret.revision,true).unwrap();
    assert!(export_at(&c,"w",&root,None).is_err());assert!(!root.exists());
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
