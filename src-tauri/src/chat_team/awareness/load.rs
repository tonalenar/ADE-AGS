//! A carga da máquina, para o orquestrador decidir se lança mais um agente: load average, CPU, memória livre e
//! quantas compilações (`cargo`/`rustc`) estão rodando. Só lê (`getloadavg`, `ps`, `vm_stat`, `/proc/meminfo`); o que
//! decide é puro e fica testável: o texto do sistema entra por parâmetro.

use std::time::Duration;

use serde::Serialize;

/// Acima de `núcleos × 2` de load average (1 min) a máquina conta como sobrecarregada.
pub const LOAD_PER_CORE_LIMIT: f64 = 2.0;
/// Memória livre abaixo disso (MiB) é só avisada, nunca recusa sozinha.
pub const LOW_MEMORY_MB: u64 = 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// `false` onde não há como medir (Windows): nada é recusado por carga.
    pub supported: bool,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cores: u32,
    /// Soma do uso de CPU dos processos, em % de um núcleo (pode passar de 100 com vários núcleos).
    pub cpu_percent: Option<f64>,
    pub mem_total_mb: Option<u64>,
    pub mem_free_mb: Option<u64>,
    pub cargo_procs: u32,
    pub rustc_procs: u32,
    /// Compilações em andamento (um `cargo` por compilação).
    pub builds: u32,
    /// O load (1 min) acima do qual a carga conta como alta.
    pub threshold: f64,
    pub overloaded: bool,
    /// Frase pronta para o orquestrador repetir ao usuário.
    pub summary: String,
}

pub fn threshold_for(cores: u32) -> f64 {
    f64::from(cores.max(1)) * LOAD_PER_CORE_LIMIT
}

/// O que `ps` e o sistema devolveram, já lido.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parts {
    pub supported: bool,
    pub avg: [f64; 3],
    pub cores: u32,
    pub cpu_percent: Option<f64>,
    pub mem_total_mb: Option<u64>,
    pub mem_free_mb: Option<u64>,
    pub cargo_procs: u32,
    pub rustc_procs: u32,
}

pub fn build(parts: Parts) -> Load {
    let threshold = threshold_for(parts.cores);
    let overloaded = parts.supported && parts.avg[0] > threshold;
    let builds = parts.cargo_procs;
    let summary = if !parts.supported {
        "carga da máquina não medida neste sistema".to_string()
    } else {
        let mut text = format!(
            "carga {:.1} em {} núcleos (limite {:.0}); {} compilação(ões) cargo, {} rustc",
            parts.avg[0], parts.cores, threshold, builds, parts.rustc_procs
        );
        if let Some(free) = parts.mem_free_mb {
            text.push_str(&format!("; {free} MiB livres"));
            if free < LOW_MEMORY_MB {
                text.push_str(" (pouca memória)");
            }
        }
        text.push_str(if overloaded { " — ALTA: espere baixar antes de lançar mais agentes" } else { " — ok" });
        text
    };
    Load {
        supported: parts.supported,
        load1: parts.avg[0],
        load5: parts.avg[1],
        load15: parts.avg[2],
        cores: parts.cores,
        cpu_percent: parts.cpu_percent,
        mem_total_mb: parts.mem_total_mb,
        mem_free_mb: parts.mem_free_mb,
        cargo_procs: parts.cargo_procs,
        rustc_procs: parts.rustc_procs,
        builds,
        threshold,
        overloaded,
        summary,
    }
}

/// `ps -A -o %cpu=,comm=`: a soma do CPU e quantos processos são `cargo` e `rustc` (pelo nome do executável).
pub fn parse_ps(text: &str) -> (f64, u32, u32) {
    let (mut cpu, mut cargo, mut rustc) = (0.0, 0, 0);
    for line in text.lines() {
        let line = line.trim_start();
        let Some((percent, command)) = line.split_once(char::is_whitespace) else { continue };
        let Ok(percent) = percent.replace(',', ".").parse::<f64>() else { continue };
        cpu += percent;
        let name = command.trim().rsplit(['/', '\\']).next().unwrap_or("");
        match name {
            "cargo" | "cargo.exe" => cargo += 1,
            "rustc" | "rustc.exe" => rustc += 1,
            _ => {}
        }
    }
    (cpu, cargo, rustc)
}

/// `sysctl -n vm.loadavg` do macOS (`{ 1.20 1.50 1.70 }`) ou `/proc/loadavg` do Linux (`1.20 1.50 1.70 1/300 123`).
pub fn parse_loadavg(text: &str) -> Option<[f64; 3]> {
    let mut numbers = text.split(|c: char| c.is_whitespace() || c == '{' || c == '}').filter(|t| !t.is_empty()).map(|t| t.replace(',', ".").parse::<f64>());
    Some([numbers.next()?.ok()?, numbers.next()?.ok()?, numbers.next()?.ok()?])
}

/// `vm_stat` do macOS: livre = livre + inativa + especulativa.
pub fn parse_vm_stat(text: &str) -> Option<u64> {
    let page = text
        .lines()
        .next()
        .and_then(|head| head.split("page size of ").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse::<u64>().ok())?;
    let pages = |label: &str| -> u64 {
        text.lines()
            .find(|line| line.trim_start().starts_with(label))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|value| value.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    let free = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
    Some(free * page / (1024 * 1024))
}

/// `/proc/meminfo` do Linux: `(total, disponível)` em MiB.
pub fn parse_meminfo(text: &str) -> Option<(u64, u64)> {
    let kb = |label: &str| -> Option<u64> {
        text.lines()
            .find(|line| line.starts_with(label))?
            .split_whitespace()
            .nth(1)?
            .parse::<u64>()
            .ok()
    };
    Some((kb("MemTotal:")? / 1024, kb("MemAvailable:")? / 1024))
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = crate::util::spawn::hidden_command(program);
    cmd.args(args);
    let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(5)).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Mede agora. Nunca falha: o que não se consegue ler fica `None`.
#[cfg(unix)]
pub fn sample() -> Load {
    let avg = if cfg!(target_os = "macos") {
        run("sysctl", &["-n", "vm.loadavg"]).and_then(|t| parse_loadavg(&t))
    } else {
        std::fs::read_to_string("/proc/loadavg").ok().and_then(|t| parse_loadavg(&t))
    };
    let cores = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    let (cpu, cargo, rustc) = run("ps", &["-A", "-o", "%cpu=,comm="]).map(|t| parse_ps(&t)).map_or((None, 0, 0), |(c, a, b)| (Some(c), a, b));
    let (total, free) = if cfg!(target_os = "macos") {
        (
            run("sysctl", &["-n", "hw.memsize"]).and_then(|t| t.trim().parse::<u64>().ok()).map(|b| b / (1024 * 1024)),
            run("vm_stat", &[]).and_then(|t| parse_vm_stat(&t)),
        )
    } else {
        match std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| parse_meminfo(&t)) {
            Some((total, free)) => (Some(total), Some(free)),
            None => (None, None),
        }
    };
    build(Parts {
        supported: avg.is_some(),
        avg: avg.unwrap_or([0.0; 3]),
        cores,
        cpu_percent: cpu,
        mem_total_mb: total,
        mem_free_mb: free,
        cargo_procs: cargo,
        rustc_procs: rustc,
    })
}

#[cfg(not(unix))]
pub fn sample() -> Load {
    let cores = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    build(Parts { supported: false, cores, ..Parts::default() })
}
