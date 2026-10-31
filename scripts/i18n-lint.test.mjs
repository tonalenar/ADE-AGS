// Testes do lint de i18n (scripts/i18n-lint.mjs).
// Rodar: node --test scripts/i18n-lint.test.mjs
// Sem deps, sem relógio real e sem polling: tudo roda numa pasta temporária.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeCatalogs, scanSources, run } from './i18n-lint.mjs';

// Cria uma raiz de mentira (src/, scripts/ e os arquivos dados) e a apaga ao fim do teste.
function criarRaiz(ctx, arquivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-lint-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, conteudo);
  }
  return dir;
}

// Catálogos e fonte mínimos para os testes de run(): pt-BR é a referência.
function arquivosBase({ ptBR = '{"app":{"sair":"Sair"}}', en = '{"app":{"sair":"Exit"}}' } = {}) {
  return {
    'src/i18n/locales/pt-BR.json': ptBR,
    'src/i18n/locales/en.json': en,
    'src/i18n/locales/es.json': '{"app":{"sair":"Salir"}}',
    'src/app/Botao.tsx': 'export const Botao = () => t("app.sair");\n',
  };
}

// pt-BR com "sair" duplicada: a duplicata antiga, que entra no baseline.
const PT_COM_DUPLICATA_ANTIGA = '{\n  "app": {\n    "sair": "Sair",\n    "sair": "Saia"\n  }\n}';

// Mesma duplicata antiga, mais uma duplicata nova (app.novo).
const PT_COM_DUPLICATA_NOVA = [
  '{',
  '  "app": {',
  '    "sair": "Sair",',
  '    "sair": "Saia",',
  '    "novo": "Novo",',
  '    "novo": "Novo 2"',
  '  }',
  '}',
].join('\n');

const PT_KEYS = new Set(['app.sair', 'app.titulo']);

// ---------- analyzeCatalogs ----------

test('chave faltando em en é apontada, com caminho aninhado a.b.c', () => {
  const r = analyzeCatalogs({
    'pt-BR': '{"a":{"b":{"c":"Oi"}}}',
    en: '{"a":{"b":{}}}',
    es: '{"a":{"b":{"c":"Hola"}}}',
  });
  assert.equal(r.missing.length, 1);
  const m = r.missing[0];
  assert.equal(m.key, 'a.b.c');
  assert.deepEqual([...m.missingIn].sort(), ['en']);
  assert.deepEqual([...m.presentIn].sort(), ['es', 'pt-BR']);
});

test('chave duplicada no mesmo objeto é apontada, com as linhas', () => {
  const pt = '{\n  "app": {\n    "sair": "Sair",\n    "sair": "Saia"\n  }\n}';
  const r = analyzeCatalogs({
    'pt-BR': pt,
    en: '{"app":{"sair":"Exit"}}',
    es: '{"app":{"sair":"Salir"}}',
  });
  assert.equal(r.duplicates.length, 1);
  const d = r.duplicates[0];
  assert.equal(d.lang, 'pt-BR');
  assert.equal(d.key, 'app.sair');
  assert.deepEqual(d.lines, [3, 4]);
});

test('placeholder diferente entre idiomas ({{count}} vs {{n}}) é apontado', () => {
  const r = analyzeCatalogs({
    'pt-BR': '{"x":{"msg":"Você tem {{count}} itens"}}',
    en: '{"x":{"msg":"You have {{n}} items"}}',
    es: '{"x":{"msg":"Tienes {{count}} artículos"}}',
  });
  assert.equal(r.placeholders.length, 1);
  assert.equal(r.placeholders[0].key, 'x.msg');
  // Forma assumida de byLang: { [lang]: [nomes dos placeholders] }.
  assert.deepEqual(r.placeholders[0].byLang, { 'pt-BR': ['count'], en: ['n'], es: ['count'] });
});

test('placeholders iguais em todos os idiomas não acusam', () => {
  const r = analyzeCatalogs({
    'pt-BR': '{"x":{"msg":"Você tem {{count}} itens"}}',
    en: '{"x":{"msg":"You have {{count}} items"}}',
    es: '{"x":{"msg":"Tienes {{count}} artículos"}}',
  });
  assert.deepEqual(r.placeholders, []);
});

test('plural _one sem _other é apontado', () => {
  // Só _one nos três idiomas: não há faltante entre idiomas, só o plural incompleto.
  const soOne = '{"x":{"itens_one":"1 item"}}';
  const r = analyzeCatalogs({ 'pt-BR': soOne, en: soOne, es: soOne });
  const pt = r.plurals.find((p) => p.lang === 'pt-BR');
  assert.ok(pt, 'deveria acusar o plural incompleto em pt-BR');
  assert.equal(pt.base, 'x.itens');
  assert.ok(pt.missing.map(String).some((m) => m.includes('other')), 'missing deveria citar other');
});

test('plural completo (_one e _other) não acusa', () => {
  const r = analyzeCatalogs({
    'pt-BR': '{"x":{"itens_one":"1 item","itens_other":"{{count}} itens"}}',
    en: '{"x":{"itens_one":"1 item","itens_other":"{{count}} items"}}',
    es: '{"x":{"itens_one":"1 item","itens_other":"{{count}} artículos"}}',
  });
  assert.deepEqual(r.plurals, []);
});

// ---------- scanSources ----------

test('t("nao.existe") é acusado com arquivo e linha', () => {
  const r = scanSources(
    [{ path: 'src/app/A.tsx', text: 'const a = 1;\nexport const B = () => t("nao.existe");\n' }],
    PT_KEYS,
  );
  assert.deepEqual(
    r.unknown.map(({ key, file, line }) => ({ key, file, line })),
    [{ key: 'nao.existe', file: 'src/app/A.tsx', line: 2 }],
  );
});

test('i18n.t("x") e t("x") com chave existente são reconhecidos e entram em usedKeys', () => {
  const r = scanSources(
    [{ path: 'src/app/B.tsx', text: "i18n.t('app.sair');\nt('app.titulo');\n" }],
    PT_KEYS,
  );
  assert.deepEqual(r.unknown, []);
  assert.ok(r.usedKeys.has('app.sair'));
  assert.ok(r.usedKeys.has('app.titulo'));
});

test('i18n.t("nao.existe") é acusado', () => {
  const r = scanSources([{ path: 'src/app/B.tsx', text: "i18n.t('nao.existe');\n" }], PT_KEYS);
  assert.deepEqual(
    r.unknown.map(({ key, line }) => ({ key, line })),
    [{ key: 'nao.existe', line: 1 }],
  );
});

test('chaves dinâmicas (template, concatenação e variável) não acusam e contam em dynamicIgnored', () => {
  const text = 'const a = t(`a.${b}`);\nconst c = t("a." + b);\nconst d = t(k);\n';
  const r = scanSources([{ path: 'src/app/C.tsx', text }], PT_KEYS);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.dynamicIgnored, 3);
  assert.equal(r.usedKeys.size, 0);
});

test('t("x", {count}) é válido quando só x_one e x_other existem', () => {
  const r = scanSources(
    [{ path: 'src/app/D.tsx', text: 't("x", { count: n });\n' }],
    new Set(['x_one', 'x_other']),
  );
  assert.deepEqual(r.unknown, []);
});

test('t("x", {count}) sem x_one, x_other nem x é acusado', () => {
  const r = scanSources(
    [{ path: 'src/app/D.tsx', text: 't("x", { count: n });\n' }],
    new Set(['outra.chave']),
  );
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].key, 'x');
});

// ---------- run ----------

test('run({update:true}) grava o baseline em scripts/i18n-lint-baseline.json', async (ctx) => {
  const root = criarRaiz(ctx, arquivosBase({ ptBR: PT_COM_DUPLICATA_ANTIGA }));
  await run({ root, update: true });
  const baseline = path.join(root, 'scripts', 'i18n-lint-baseline.json');
  assert.ok(fs.existsSync(baseline), 'o baseline deveria ter sido gravado');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(baseline, 'utf8')));
});

test('run() com a duplicata antiga já no baseline dá ok=true', async (ctx) => {
  const root = criarRaiz(ctx, arquivosBase({ ptBR: PT_COM_DUPLICATA_ANTIGA }));
  await run({ root, update: true });
  const res = await run({ root });
  assert.equal(res.ok, true);
  assert.deepEqual(res.novos, []);
});

test('run() com uma duplicata nova, fora do baseline, dá ok=false', async (ctx) => {
  const root = criarRaiz(ctx, arquivosBase({ ptBR: PT_COM_DUPLICATA_ANTIGA }));
  await run({ root, update: true });
  // Mantém a duplicata antiga e acrescenta app.novo (duplicada só em pt-BR).
  fs.writeFileSync(path.join(root, 'src/i18n/locales/pt-BR.json'), PT_COM_DUPLICATA_NOVA);
  fs.writeFileSync(
    path.join(root, 'src/i18n/locales/en.json'),
    '{"app":{"sair":"Exit","novo":"New"}}',
  );
  fs.writeFileSync(
    path.join(root, 'src/i18n/locales/es.json'),
    '{"app":{"sair":"Salir","novo":"Nuevo"}}',
  );
  const res = await run({ root });
  assert.equal(res.ok, false);
  assert.equal(res.novos.length, 1, 'só a duplicata nova deveria ser novidade');
  assert.ok(JSON.stringify(res.novos).includes('app.novo'));
});
