//! Escreve e devolve o `disabled.plist` do aparelho (ver `simulator::slim`). Só com o aparelho desligado: o
//! `launchd_sim` lê o arquivo quando sobe.

use std::fs;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::sel;

use super::objc::{call, class, ns_string};
use crate::simulator::slim;

/// Uma troca do modo leve de cada vez: dois boots do mesmo aparelho (a UI e um agente) não intercalam cópias (A273).
fn exclusive() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Põe os serviços do nível pedido (`Light` ou `Max`) como desligados, guardando antes o original, exceto as
/// categorias em `exceptions`. Devolve quantos rótulos o arquivo tem agora.
pub fn apply(udid: &str, level: slim::Level, exceptions: &[String]) -> Result<usize, String> {
    let _exclusive = exclusive();
    apply_inner(udid, level, exceptions)
}

fn apply_inner(udid: &str, level: slim::Level, exceptions: &[String]) -> Result<usize, String> {
    let (file, original) = slim::paths(udid).ok_or("UDID inválido.")?;
    // Sobrou cópia de uma vez que não terminou (a ADE caiu no meio do boot): ela é o original de verdade.
    restore_inner(udid);
    fs::create_dir_all(file.parent().ok_or("caminho sem pasta")?).map_err(|e| e.to_string())?;
    if file.exists() {
        fs::copy(&file, &original).map_err(|e| format!("Não guardei o original do modo leve: {e}"))?;
    } else {
        fs::write(&original, b"").map_err(|e| e.to_string())?;
    }
    let path = ns_string(&file.to_string_lossy());
    let path_ptr = Retained::as_ptr(&path) as *mut AnyObject;
    // SAFETY: NSMutableDictionary e NSNumber públicos; `dictionaryWithContentsOfFile:` devolve +0 ou nil.
    let written = unsafe {
        let dict_class = class(c"NSMutableDictionary").expect("Foundation");
        let mut dict = call!(dict_class, sel!(dictionaryWithContentsOfFile:), path_ptr => *mut AnyObject; -> *mut AnyObject);
        if dict.is_null() {
            dict = call!(dict_class, sel!(dictionary); -> *mut AnyObject);
        }
        let yes = call!(class(c"NSNumber").expect("Foundation"), sel!(numberWithBool:), true => bool; -> *mut AnyObject);
        for label in level.labels(exceptions) {
            let key = ns_string(label);
            call!(dict, sel!(setObject:forKey:), yes => *mut AnyObject, Retained::as_ptr(&key) as *mut AnyObject => *mut AnyObject; -> ());
        }
        let ok = call!(dict, sel!(writeToFile:atomically:), path_ptr => *mut AnyObject, true => bool; -> bool);
        ok.then(|| call!(dict, sel!(count); -> usize))
    };
    match written {
        Some(count) => Ok(count),
        None => {
            restore_inner(udid);
            Err("Não consegui escrever a lista de serviços do modo leve.".into())
        }
    }
}

/// Devolve o arquivo original, se a ADE o trocou. Sem cópia guardada não faz nada.
pub fn restore(udid: &str) {
    let _exclusive = exclusive();
    restore_inner(udid);
}

fn restore_inner(udid: &str) {
    let Some((file, original)) = slim::paths(udid) else { return };
    let Ok(meta) = fs::metadata(&original) else { return };
    let result = if meta.len() == 0 {
        fs::remove_file(&original).and_then(|_| match fs::remove_file(&file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        })
    } else {
        fs::rename(&original, &file)
    };
    if let Err(e) = result {
        eprintln!("[simulator] não devolvi o disabled.plist original de {udid}: {e}");
    }
}

/// Devolve o original de todo aparelho que ficou com o arquivo trocado (a ADE caiu no meio de um boot).
pub fn restore_leftovers() {
    let Ok(entries) = fs::read_dir("/private/var/tmp") else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(udid) = name.to_str().and_then(|n| n.strip_prefix("com.apple.CoreSimulator.SimDevice.")) else { continue };
        if entry.path().join("disabled.ade-original.plist").exists() {
            restore(udid);
        }
    }
}
