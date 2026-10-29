//! Escreve e devolve o `disabled.plist` do aparelho (ver `simulator::slim`). Só com o aparelho desligado: o
//! `launchd_sim` lê o arquivo quando sobe.

use std::fs;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::sel;

use super::objc::{call, class, ns_string};
use crate::simulator::slim;

/// Põe os serviços do modo leve como desligados, guardando antes o original. Devolve quantos rótulos o arquivo
/// tem agora.
pub fn apply(udid: &str) -> Result<usize, String> {
    let (file, original) = slim::paths(udid).ok_or("UDID inválido.")?;
    // Sobrou cópia de uma vez que não terminou (a ADE caiu no meio do boot): ela é o original de verdade.
    restore(udid);
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
        for label in slim::LABELS {
            let key = ns_string(label);
            call!(dict, sel!(setObject:forKey:), yes => *mut AnyObject, Retained::as_ptr(&key) as *mut AnyObject => *mut AnyObject; -> ());
        }
        let ok = call!(dict, sel!(writeToFile:atomically:), path_ptr => *mut AnyObject, true => bool; -> bool);
        ok.then(|| call!(dict, sel!(count); -> usize))
    };
    match written {
        Some(count) => Ok(count),
        None => {
            restore(udid);
            Err("Não consegui escrever a lista de serviços do modo leve.".into())
        }
    }
}

/// Devolve o arquivo original, se a ADE o trocou. Sem cópia guardada não faz nada.
pub fn restore(udid: &str) {
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
