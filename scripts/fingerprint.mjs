// Fingerprint dos tipos persistidos: SHA-256 do schema SQLite e do protocolo IPC.
//
//   node scripts/fingerprint.mjs                       # check: falha se um hash mudou sem registro
//   node scripts/fingerprint.mjs --mostrar             # só imprime os hashes atuais
//   node scripts/fingerprint.mjs --reconhecer schema-sqlite --motivo "coluna X em Y, aditiva" --sem-perda-de-dados
//   node scripts/fingerprint.mjs --reconhecer protocolo-ipc --motivo "campo opcional Z na resposta W"
//
// O hash é do fonte NORMALIZADO: sem comentários e com os espaços colapsados, mas com as strings
// intactas (o SQL das migrações mora nelas). Mudar um comentário ou reindentar não pede registro;
// mudar uma coluna, um tipo ou um campo pede.
//
// Cada reconhecimento é um arquivo em `docs/decisoes/fingerprints/<alvo>-<sha12>.json`. Um arquivo
// por mudança, e não uma lista, para dois PRs paralelos não brigarem no merge. O check passa
// quando existe um registro com o hash atual de cada alvo. Formato e motivo: `docs/decisoes/FINGERPRINT.md`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PASTA_REGISTROS = "docs/decisoes/fingerprints";

/** O que é fingerprintado. `semPerda`: o registro tem de afirmar que a mudança não apaga dados. */
export const ALVOS = {
  "schema-sqlite": { arquivos: ["src-tauri/src/database/schema.rs"], semPerda: true },
  "protocolo-ipc": { arquivos: ["src-tauri/src/ipc/protocol.rs"], semPerda: false },
};

/**
 * Fonte Rust sem comentários e com espaços colapsados; strings, raw strings e literais de
 * caractere passam como estão. Lifetimes (`'a`) não são confundidos com caractere.
 */
export function normalizarRust(fonte) {
  // Checkout do Windows com autocrlf: a string SQL de várias linhas não pode mudar o hash.
  const src = fonte.replace(/\r\n?/g, "\n");
  let out = "";
  let i = 0;
  const n = src.length;
  let espaco = false;
  const emitir = (s) => {
    if (espaco && out.length > 0) out += " ";
    espaco = false;
    out += s;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      espaco = true;
      continue;
    }
    if (c === "/" && d === "*") {
      // Comentário de bloco do Rust aninha.
      let nivel = 0;
      do {
        if (src[i] === "/" && src[i + 1] === "*") { nivel++; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { nivel--; i += 2; }
        else i++;
      } while (i < n && nivel > 0);
      espaco = true;
      continue;
    }
    if (/\s/.test(c)) {
      espaco = true;
      i++;
      continue;
    }
    // Raw string: r"…", r#"…"#, br#"…"#.
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 260));
    if (raw && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const fim = '"' + raw[1];
      const j = src.indexOf(fim, i + raw[0].length);
      const ate = j < 0 ? n : j + fim.length;
      emitir(src.slice(i, ate));
      i = ate;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      emitir(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // Literal de caractere: 'x', '\n', '\u{1F600}', '"'. Senão é lifetime.
      const lit = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'/u.exec(src.slice(i, i + 12));
      if (lit) {
        emitir(lit[0]);
        i += lit[0].length;
        continue;
      }
    }
    emitir(c);
    i++;
  }
  return out;
}

export function sha256(texto) {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/** Hash de um alvo: arquivos normalizados, cada um precedido do caminho. */
export function hashDoAlvo(alvo, ler = (p) => readFileSync(join(RAIZ, p), "utf8")) {
  const partes = ALVOS[alvo].arquivos.map((p) => `== ${p}\n${normalizarRust(ler(p))}\n`);
  return sha256(partes.join(""));
}

/** Confere um registro. Devolve a lista de problemas (vazia se está bom). */
export function validarRegistro(reg, nomeArquivo) {
  const erros = [];
  if (!ALVOS[reg?.alvo]) erros.push(`alvo desconhecido: ${reg?.alvo}`);
  if (!/^[0-9a-f]{64}$/.test(reg?.sha256 ?? "")) erros.push("sha256 inválido");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reg?.data ?? "")) erros.push("data deve ser AAAA-MM-DD");
  if (typeof reg?.motivo !== "string" || reg.motivo.trim().length < 10) erros.push("motivo com ao menos 10 caracteres");
  if (ALVOS[reg?.alvo]?.semPerda && reg?.semPerdaDeDados !== true) {
    erros.push("schema-sqlite exige \"semPerdaDeDados\": true (regra de ouro: nenhuma migração apaga dados do usuário)");
  }
  if (nomeArquivo && reg?.alvo && reg?.sha256 && nomeArquivo !== nomeDoRegistro(reg.alvo, reg.sha256)) {
    erros.push(`o arquivo deveria se chamar ${nomeDoRegistro(reg.alvo, reg.sha256)}`);
  }
  return erros;
}

export function nomeDoRegistro(alvo, sha) {
  return `${alvo}-${sha.slice(0, 12)}.json`;
}

/** Junta hashes atuais e registros: o que falta reconhecer e os registros malformados. */
export function conferir(atuais, registros) {
  const invalidos = [];
  const reconhecidos = new Set();
  for (const { nome, reg } of registros) {
    const erros = validarRegistro(reg, nome);
    if (erros.length > 0) invalidos.push({ nome, erros });
    else reconhecidos.add(`${reg.alvo}:${reg.sha256}`);
  }
  const pendentes = Object.entries(atuais)
    .filter(([alvo, sha]) => !reconhecidos.has(`${alvo}:${sha}`))
    .map(([alvo, sha]) => ({ alvo, sha }));
  return { pendentes, invalidos };
}

function lerRegistros() {
  const pasta = join(RAIZ, PASTA_REGISTROS);
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith(".json"))
    .map((nome) => {
      try {
        return { nome, reg: JSON.parse(readFileSync(join(pasta, nome), "utf8")) };
      } catch (e) {
        return { nome, reg: null, erro: String(e) };
      }
    });
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function main(argv) {
  const arg = (nome) => {
    const i = argv.indexOf(nome);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const atuais = Object.fromEntries(Object.keys(ALVOS).map((alvo) => [alvo, hashDoAlvo(alvo)]));

  if (argv.includes("--mostrar")) {
    for (const [alvo, sha] of Object.entries(atuais)) console.log(`${alvo}  ${sha}`);
    return 0;
  }

  const alvo = arg("--reconhecer");
  if (alvo) {
    if (!ALVOS[alvo]) {
      console.error(`alvo desconhecido: ${alvo}. Alvos: ${Object.keys(ALVOS).join(", ")}`);
      return 2;
    }
    const reg = {
      alvo,
      sha256: atuais[alvo],
      data: hoje(),
      motivo: arg("--motivo") ?? "",
      ...(ALVOS[alvo].semPerda ? { semPerdaDeDados: argv.includes("--sem-perda-de-dados") } : {}),
      arquivos: ALVOS[alvo].arquivos,
    };
    const erros = validarRegistro(reg);
    if (erros.length > 0) {
      console.error(`registro recusado:\n  - ${erros.join("\n  - ")}`);
      return 2;
    }
    mkdirSync(join(RAIZ, PASTA_REGISTROS), { recursive: true });
    const destino = join(PASTA_REGISTROS, nomeDoRegistro(alvo, reg.sha256));
    writeFileSync(join(RAIZ, destino), JSON.stringify(reg, null, 2) + "\n");
    console.log(`registrado: ${destino}. Commite junto com a mudança.`);
    return 0;
  }

  const registros = lerRegistros();
  const { pendentes, invalidos } = conferir(atuais, registros.map(({ nome, reg }) => ({ nome, reg })));
  for (const { nome, erros } of invalidos) {
    console.error(`registro inválido ${PASTA_REGISTROS}/${nome}:\n  - ${erros.join("\n  - ")}`);
  }
  for (const { alvo, sha } of pendentes) {
    const extra = ALVOS[alvo].semPerda ? " --sem-perda-de-dados" : "";
    console.error(
      `${alvo} mudou (${ALVOS[alvo].arquivos.join(", ")}; sha256 ${sha.slice(0, 12)}…) e não tem registro de reconhecimento.\n` +
        `  Revise a mudança (docs/decisoes/FINGERPRINT.md) e rode:\n` +
        `  node scripts/fingerprint.mjs --reconhecer ${alvo} --motivo "<o que mudou e por quê>"${extra}`,
    );
  }
  if (pendentes.length > 0 || invalidos.length > 0) return 1;
  console.log(`fingerprint ok: ${Object.entries(atuais).map(([a, s]) => `${a} ${s.slice(0, 12)}`).join(", ")}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
