import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LANGS = ['pt-BR', 'en', 'es'];

// O JSON.parse valida a sintaxe; o percurso textual preserva duplicatas e linhas.
function catalog(text, lang) {
  JSON.parse(text);
  let pos = 0;
  const values = new Map();
  const duplicates = [];
  const space = () => { while (/\s/.test(text[pos] ?? '') && pos < text.length) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos++] === '\\') pos++;
      else if (text[pos - 1] === '"') break;
    }
    return JSON.parse(text.slice(start, pos));
  };
  function value(path) {
    space();
    if (text[pos] === '{') {
      pos++;
      const seen = new Map();
      space();
      while (text[pos] !== '}') {
        const line = text.slice(0, pos).split('\n').length;
        const key = string();
        const lines = seen.get(key) ?? [];
        lines.push(line);
        seen.set(key, lines);
        space(); pos++; value([...path, key]); space();
        if (text[pos] !== ',') break;
        pos++; space();
      }
      pos++;
      for (const [key, lines] of seen) if (lines.length > 1) duplicates.push({ lang, key: [...path, key].join('.'), lines });
    } else if (text[pos] === '[') {
      pos++; space(); let index = 0;
      while (text[pos] !== ']') {
        value([...path, String(index++)]); space();
        if (text[pos] !== ',') break;
        pos++; space();
      }
      pos++;
    } else if (text[pos] === '"') values.set(path.join('.'), string());
    else {
      const start = pos;
      while (pos < text.length && !/[,}\]\s]/.test(text[pos])) pos++;
      values.set(path.join('.'), text.slice(start, pos));
    }
  }
  value([]);
  return { values, duplicates };
}

export function analyzeCatalogs(textsByLang) {
  const langs = Object.keys(textsByLang);
  const catalogs = Object.fromEntries(langs.map(lang => [lang, catalog(textsByLang[lang], lang)]));
  const keys = [...new Set(langs.flatMap(lang => [...catalogs[lang].values.keys()]))].sort();
  const duplicates = langs.flatMap(lang => catalogs[lang].duplicates);
  const missing = [], placeholders = [], plurals = [];
  for (const key of keys) {
    const presentIn = langs.filter(lang => catalogs[lang].values.has(key));
    const missingIn = langs.filter(lang => !catalogs[lang].values.has(key));
    if (missingIn.length) missing.push({ key, presentIn, missingIn });
    const byLang = Object.fromEntries(presentIn.map(lang => [lang,
      [...new Set([...String(catalogs[lang].values.get(key)).matchAll(/{{\s*-?\s*([^{}]+?)\s*}}/g)].map(m => m[1].trim()))].sort(),
    ]));
    if (new Set(Object.values(byLang).map(v => JSON.stringify(v))).size > 1) placeholders.push({ key, byLang });
  }
  for (const lang of langs) {
    const values = catalogs[lang].values;
    const bases = new Set([...values.keys()].filter(k => /_(one|other)$/.test(k)).map(k => k.replace(/_(one|other)$/, '')));
    for (const base of [...bases].sort()) {
      const missing = ['one', 'other'].filter(s => !values.has(`${base}_${s}`)).map(s => `${base}_${s}`);
      if (missing.length) plurals.push({ lang, base, missing });
    }
  }
  return { duplicates, missing, placeholders, plurals };
}

// Tokens bastam para distinguir chamadas literais, comentários e expressões dinâmicas.
function tokens(text) {
  const out = [];
  let i = 0, line = 1;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { if (c === '\n') line++; i++; continue; }
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) {
      i += 2;
      while (i < text.length && !text.startsWith('*/', i)) { if (text[i++] === '\n') line++; }
      i += 2; continue;
    }
    const start = i, ln = line;
    if ('"\'`'.includes(c)) {
      i++; let value = '', dynamic = false;
      while (i < text.length && text[i] !== c) {
        if (c === '`' && text.startsWith('${', i)) dynamic = true;
        if (text[i] === '\\') {
          i++;
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
          const unicode = /^u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/.exec(text.slice(i));
          const hex = /^x([0-9a-fA-F]{2})/.exec(text.slice(i));
          if (unicode) { value += String.fromCodePoint(parseInt(unicode[1] ?? unicode[2], 16)); i += unicode[0].length; }
          else if (hex) { value += String.fromCodePoint(parseInt(hex[1], 16)); i += hex[0].length; }
          else if (text[i] === '\n') { line++; i++; }
          else { value += escapes[text[i]] ?? text[i] ?? ''; i++; }
        } else { if (text[i] === '\n') line++; value += text[i++]; }
      }
      i++;
      out.push({ value, type: dynamic ? 'dynamic' : 'string', line: ln });
    } else if (/[\w$]/.test(c)) {
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      out.push({ value: text.slice(start, i), type: 'word', line: ln });
    } else { out.push({ value: c, type: 'punct', line }); i++; }
  }
  return out;
}

export function scanSources(files, ptKeys) {
  const unknown = [], usedKeys = new Set();
  let dynamicIgnored = 0;
  for (const { path: file, text } of files) {
    const ts = tokens(text);
    for (let i = 0; i < ts.length; i++) {
      if (ts[i].value !== 't' || ts[i].type !== 'word' || ts[i + 1]?.value !== '(') continue;
      // Métodos de outros objetos não são o tradutor do i18next.
      if (ts[i - 1]?.value === '.' && ts[i - 2]?.value !== 'i18n') continue;
      if (ts[i - 1]?.value === 'function') continue;
      const arg = ts[i + 2], next = ts[i + 3];
      if (!arg || arg.type !== 'string' || ![',', ')'].includes(next?.value)) { dynamicIgnored++; continue; }
      let key = arg.value;
      if (key.startsWith('translation:')) key = key.slice('translation:'.length);
      usedKeys.add(key);
      let end = i + 3, depth = 1;
      for (; end < ts.length; end++) {
        if (ts[end].value === '(') depth++;
        if (ts[end].value === ')' && --depth === 0) break;
      }
      const hasCount = ts.slice(i + 3, end).some(t => t.type === 'word' && t.value === 'count');
      const plural = hasCount && ptKeys.has(`${key}_one`) && ptKeys.has(`${key}_other`);
      if (!ptKeys.has(key) && !plural) unknown.push({ key, file, line: ts[i].line });
    }
  }
  return { unknown, dynamicIgnored, usedKeys };
}

function sources(root, dir = join(root, 'src')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['tests', '__tests__', 'node_modules'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(root, path);
    return /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path)
      ? [{ path: relative(root, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }] : [];
  });
}

// A identidade não depende da linha: mover código não torna uma dívida antiga nova.
function identity(kind, finding) {
  const { line, lines, ...stable } = finding;
  return JSON.stringify([kind, stable, ...(kind === 'duplicates' ? [lines.length] : [])]);
}

export function run({ root, update = false }) {
  root = resolve(root);
  const texts = Object.fromEntries(LANGS.map(lang => [lang, readFileSync(join(root, 'src/i18n/locales', `${lang}.json`), 'utf8')]));
  const report = { ...analyzeCatalogs(texts), ...scanSources(sources(root), new Set(catalog(texts['pt-BR'], 'pt-BR').values.keys())) };
  const findings = ['duplicates', 'missing', 'placeholders', 'plurals', 'unknown'].flatMap(kind => report[kind].map(finding => ({ kind, ...finding })));
  const counts = {};
  for (const { kind, ...finding } of findings) {
    const id = identity(kind, finding);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  const baselinePath = join(root, 'scripts/i18n-lint-baseline.json');
  if (update) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify({ _leia: 'Dívida antiga do i18n. Só deve diminuir; nunca absorva achados novos. Atualize com node scripts/i18n-lint.mjs --update-baseline.', violacoes: counts }, null, 2)}\n`);
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).violacoes ?? {} : {};
  const seen = {};
  const novos = findings.filter(({ kind, ...finding }) => {
    const id = identity(kind, finding);
    seen[id] = (seen[id] ?? 0) + 1;
    return seen[id] > (baseline[id] ?? 0);
  });
  return { ok: novos.length === 0, novos, report };
}

function main(args) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] !== '--update-baseline') throw new Error(`Argumento inválido: ${args[i]}`);
  }
  const result = run({ root, update: args.includes('--update-baseline') });
  const r = result.report;
  console.log(`i18n: ${r.unknown.length} usos sem chave; ${r.duplicates.length} duplicadas; ${r.missing.length} faltando entre idiomas; ${r.placeholders.length} placeholders divergentes; ${r.plurals.length} plurais incompletos; ${r.dynamicIgnored} dinâmicos ignorados; ${r.usedKeys.size} chaves usadas.`);
  for (const finding of result.novos) console.error(`${finding.file ? `${finding.file}:${finding.line}` : finding.key ?? `${finding.lang}:${finding.base}`} [${finding.kind}] ${JSON.stringify(finding)}`);
  if (!result.ok) console.error('Corrija as chaves em src/i18n/locales/{pt-BR,en,es}.json e rode node scripts/i18n-lint.mjs. O baseline só guarda dívida antiga.');
  else console.log(args.includes('--update-baseline') ? 'Baseline de i18n atualizado.' : 'Lint de i18n ok: nenhum achado novo além do baseline.');
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`Não foi possível verificar i18n: ${error.message}`); process.exitCode = 2; }
}
