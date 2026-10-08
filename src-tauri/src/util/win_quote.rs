//! Citação de argumento no estilo `CommandLineToArgvW`.
//!
//! O `portable-pty` 0.8 guarda o algoritmo em função privada. O wrapper de ConPTY
//! precisa da mesma regra, e o teste roda também no Linux.
#![cfg_attr(not(windows), allow(dead_code))]

/// Devolve `arg` citado se tiver espaço, tab, aspas ou estiver vazio.
pub fn quote_arg(arg: &str) -> String {
    let mut out = String::new();
    append_quoted(arg, &mut out);
    out
}

pub fn quote_cmdline(args: &[impl AsRef<str>]) -> String {
    args.iter().map(|arg| quote_arg(arg.as_ref())).collect::<Vec<_>>().join(" ")
}

fn append_quoted(arg: &str, cmdline: &mut String) {
    let needs = arg.is_empty()
        || arg.chars().any(|c| c == ' ' || c == '\t' || c == '\n' || c == '\u{000b}' || c == '"');
    if !needs {
        cmdline.push_str(arg);
        return;
    }
    cmdline.push('"');
    let chars: Vec<char> = arg.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let mut slashes = 0;
        while i < chars.len() && chars[i] == '\\' {
            i += 1;
            slashes += 1;
        }
        if i == chars.len() {
            for _ in 0..slashes * 2 {
                cmdline.push('\\');
            }
            break;
        } else if chars[i] == '"' {
            for _ in 0..slashes * 2 + 1 {
                cmdline.push('\\');
            }
            cmdline.push('"');
        } else {
            for _ in 0..slashes {
                cmdline.push('\\');
            }
            cmdline.push(chars[i]);
        }
        i += 1;
    }
    cmdline.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sem_espaco_vai_cru_e_com_espaco_ou_aspas_vai_citado() {
        assert_eq!(quote_arg("claude"), "claude");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(r"C:\Users\x"), r"C:\Users\x");
        assert_eq!(quote_cmdline(&["claude", "--mcp-config", r"C:\a b\x.json"]), "claude --mcp-config \"C:\\a b\\x.json\"");
    }
}
