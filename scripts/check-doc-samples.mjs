#!/usr/bin/env node
// Doc-sample compile check: do the code samples in the docs use API that exists?
//
//   node scripts/check-doc-samples.mjs                    docs/*.md + README.md
//   node scripts/check-doc-samples.mjs --only API.md      one file (name or repo-relative path;
//                                                         "README.md" is the repo README,
//                                                         "docs/README.md" the docs index)
//   node scripts/check-doc-samples.mjs --keep             keep the extracted samples and the
//                                                         result files, and print where they are
//   node scripts/check-doc-samples.mjs --verbose          also list every allow-listed diagnostic
//   node scripts/check-doc-samples.mjs --docs <dir>       check another tree that holds docs/ and
//                                                         README.md (e.g. a mirror of the docs)
//
// What it does: extracts every fenced ts/typescript/js/javascript block, wraps each one so
// that fragments parse (module, function body, class body, object body, expression,
// interface body: first wrapper that parses wins), imports the names a sample uses that
// the package root exports, declares a few ambient names (doc-samples-preamble.d.ts) and
// type-checks the lot against src/index.ts with the TypeScript the repo already depends on.
//
// Only the diagnostics that indicate non-existent API count ("API fiction": unknown
// property, unknown export, unknown option, wrong argument count/type, plus the custom
// check at the bottom). Undeclared app-side names, strictness noise and blocks that do not
// parse are counted but never fail the run.
//
// Exit code: 0 when every API-fiction diagnostic is covered by ALLOW below, 1 when at least
// one is not, 2 on a usage error. An ALLOW entry that matches nothing is reported as a
// "stale allow-list entry": a warning, never a failure.
//
// A clean run is not proof that a sample works: `any`-typed names and options, string
// values and behaviour (an option that type-checks and is read nowhere) are invisible here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, '..');
const SELF = path
  .relative(ROOT, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/');
const ts = createRequire(import.meta.url)('typescript');

// ---- allow-list -------------------------------------------------------------------------
// Known non-defects. A diagnostic is covered when its code matches, `message` matches the
// first line of the diagnostic and, when given, `file` is the markdown file (repo-relative)
// and `source` matches the offending line of the sample. Entries match on text, not on line
// numbers, so they survive edits elsewhere in the file.
//
// Keep `reason` honest: it is printed. When an entry stops matching (the doc was fixed, or
// the type was widened) the run prints "stale allow-list entry"; delete the entry then.
const ALLOW = [
  // -- Other frameworks' code, shown as the "before" half of a migration -------------------
  {
    file: 'docs/MIGRATION.md',
    code: 2554,
    message: /^Expected 2 arguments, but got 1\./,
    source: /app\.post\('\/users', validate\(schema\), handler\)/,
    reason: 'Express "before" sample: app.post(path, middleware, handler)',
  },
  {
    file: 'docs/MIGRATION.md',
    code: 2345,
    message: /^Argument of type 'any\[\]' is not assignable to parameter of type/,
    source: /\[body\('name'\)/,
    reason: 'express-validator "before" sample: validator array as the second argument',
  },
  {
    file: 'docs/MIGRATION.md',
    code: 2339,
    message: /^Property 'usersService' does not exist on type 'UsersController'/,
    reason: 'NestJS "before" sample: constructor-injected service, constructor not shown',
  },
  {
    file: 'docs/MIGRATION.md',
    code: 2339,
    message: /^Property 'switchToHttp' does not exist on type 'ExecutionContext'/,
    reason:
      'NestJS "before" sample: its ExecutionContext, which shares a name with a MoroJS export',
  },
  // -- Not MoroJS API at all ---------------------------------------------------------------
  {
    file: 'docs/CONTRIBUTING.md',
    code: 2349,
    message: /^This expression is not callable\./,
    source: /res\.status\(400\)\.json\(/,
    reason:
      'coding-style sample typed with Express Request/Response; the bare names resolve to the fetch globals',
  },
  // -- Sample-internal: the name is defined by the sample itself ---------------------------
  {
    file: 'docs/TESTING_GUIDE.md',
    code: 2339,
    message: /^Property 'insertId' does not exist on type/,
    reason: "the union is the return type of the sample's own mock database adapter",
  },
  {
    file: 'docs/TESTING_GUIDE.md',
    code: 2339,
    message: /^Property 'toBeValidUser' does not exist on type 'JestMatchers/,
    reason: 'custom Jest matcher the same sample registers with expect.extend',
  },
  // -- Checker artefact --------------------------------------------------------------------
  {
    file: 'docs/VALIDATION-LIBRARIES.md',
    code: 2339,
    message: /^Property 'body' does not exist on type '\(handler:/,
    reason:
      'leading-dot fragment (".body(...)" lines with no receiver) that chains onto the previous line',
  },
  // -- Types narrower than runtime ---------------------------------------------------------
  // The runtime supports the documented form and the published types reject it. The fix
  // belongs in src/types, not in the docs; drop the entry once the type is widened.
  {
    file: 'docs/GETTING_STARTED.md',
    code: 2345,
    message: /^Argument of type 'string' is not assignable to parameter of type 'number'/,
    source: /slice\(startIndex, endIndex\)/,
    reason:
      'req.query stays Record<string, string> for the type checker after .query(schema) coerced it',
  },
];

// ---- diagnostic classes -----------------------------------------------------------------
// tsc codes that indicate non-existent API.
const FICTION = new Set([
  2339, 2551, 2305, 2614, 2724, 2307, 2353, 2561, 2554, 2555, 2345, 2769, 2349, 2694, 2459,
]);
// Assignability and friends: mostly strictness and fragment noise. Counted, never failing.
const SECONDARY = new Set([
  2322, 2741, 2739, 2740, 2559, 2560, 2367, 2448, 2693, 2351, 2540, 2416, 2420, 2515, 2344,
]);
const SAMPLE_LANGS = new Set(['ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx', 'mjs']);

// ---- arguments --------------------------------------------------------------------------
function usage(problem) {
  console.error(`${problem}\n`);
  console.error(`usage: node ${SELF} [--only <file.md>] [--keep] [--verbose] [--docs <dir>]`);
  process.exit(2);
}
const argv = process.argv.slice(2);
const opts = { only: null, keep: false, verbose: false, docs: ROOT };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep') opts.keep = true;
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '--only' || a === '--docs') {
    const v = argv[++i];
    if (!v || v.startsWith('--')) usage(`${a} needs a value`);
    if (a === '--only') opts.only = v.replace(/^\.\//, '');
    else opts.docs = path.resolve(v);
  } else usage(`unknown argument: ${a}`);
}

// ---- extraction -------------------------------------------------------------------------
/** Markdown files to check, as { abs, rel } with rel like "docs/API.md" or "README.md". */
function listDocs() {
  const out = [];
  const dir = path.join(opts.docs, 'docs');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.md')) out.push({ abs: path.join(dir, f), rel: `docs/${f}` });
    }
  }
  const readme = path.join(opts.docs, 'README.md');
  if (fs.existsSync(readme)) out.push({ abs: readme, rel: 'README.md' });
  if (!opts.only) return out;
  const exact = out.filter(d => d.rel === opts.only);
  const picked = exact.length ? exact : out.filter(d => path.basename(d.rel) === opts.only);
  if (!picked.length) usage(`--only ${opts.only}: no such file among docs/*.md and README.md`);
  return picked;
}

/** Fenced code blocks of a markdown file: { line (1-based, of the opening fence), lang, code[] }. */
function extract(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!cur) {
      const m = /^(\s*)(```+|~~~+)\s*(\w+)?/.exec(l);
      if (m) {
        cur = { fence: m[2], indent: m[1].length, lang: (m[3] || '').toLowerCase(), start: i + 1 };
        cur.code = [];
      }
      continue;
    }
    const t = l.trim();
    if (t.startsWith(cur.fence) && t.replace(/[`~]/g, '').trim() === '') {
      if (SAMPLE_LANGS.has(cur.lang)) {
        const indent = cur.indent;
        blocks.push({
          line: cur.start,
          lang: cur.lang,
          code: cur.code.map(c => c.slice(Math.min(indent, c.length - c.trimStart().length))),
        });
      }
      cur = null;
    } else cur.code.push(l);
  }
  return blocks;
}

const parseErrors = text =>
  ts.createSourceFile('x.ts', text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS)
    .parseDiagnostics.length;

/** Line-preserving rewrites that let more samples be checked against the real types. */
function normalise(code) {
  // A config file sample (first lines name moro.config.*): type its exported object as the
  // real config so unknown keys are reported. `module.exports = {` / `export default {` only.
  if (code.slice(0, 4).some(l => /moro\.config\.(js|ts|mjs|cjs)/.test(l))) {
    const T = "import('@morojs/moro').DeepPartial<import('@morojs/moro').AppConfig>";
    let done = false;
    code = code.map(l => {
      if (done) return l;
      if (/^(module\.exports\s*=|export default)\s*\{\s*$/.test(l)) {
        done = true;
        return `const __moroConfig: ${T} = {`;
      }
      const m = /^const (config|baseConfig)\s*=\s*\{\s*$/.exec(l);
      if (m) {
        done = true;
        return `const ${m[1]}: ${T} = {`;
      }
      return l;
    });
  }
  return code.map(l => {
    // require('@morojs/...') -> import, so JS samples are checked too.
    let m =
      /^(\s*)(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\((['"])(@morojs\/[^'"]+)\3\);?\s*$/.exec(
        l
      );
    if (m) {
      const names = m[2].replace(/(\w+)\s*:\s*(\w+)/g, '$1 as $2').trim();
      return `${m[1]}import { ${names} } from '${m[4]}';`;
    }
    m = /^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*require\((['"])(@morojs\/[^'"]+)\3\);?\s*$/.exec(l);
    if (m) return `${m[1]}import * as ${m[2]} from '${m[4]}';`;
    // Elision placeholders: a bare `...` line, and `...` before a closing bracket.
    if (/^\s*\.\.\.\s*$/.test(l)) return l.replace('...', '// ...');
    return l.replace(/\.\.\.(?=\s*[)\]},])/g, '/* ... */');
  });
}

/** Separate import statements from the rest, keeping every line at its index. */
function splitImports(code) {
  const imports = [];
  const rest = [];
  let inImport = false;
  for (const l of code) {
    if (inImport) {
      imports.push(l);
      rest.push('');
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(l)) inImport = false;
      continue;
    }
    if (/^import\s/.test(l)) {
      imports.push(l);
      rest.push('');
      const oneLine =
        /from\s+['"][^'"]+['"]\s*;?\s*(\/\/.*)?$/.test(l) ||
        /^import\s+['"][^'"]+['"]\s*;?\s*(\/\/.*)?$/.test(l);
      if (!oneLine) inImport = true;
      continue;
    }
    imports.push('');
    rest.push(l);
  }
  return { imports, rest };
}

/**
 * Candidate wrappers for a sample, most literal first. Every candidate is `pre` (exactly
 * one line) + the sample on its own lines + `post`, so line numbers map back to the doc.
 */
function variants(code) {
  const { imports, rest } = splitImports(code);
  const v = [{ kind: 'module', pre: '', text: code.join('\n'), post: '\nexport {};\n' }];
  if (rest.some(l => /^export\s/.test(l))) return v;
  // Imports cannot sit inside a wrapper: hoist them onto the `pre` line.
  const hoisted = imports.filter(Boolean).join(' ');
  const body = rest.join('\n');
  const wrap = (kind, open, close, text = body) =>
    v.push({ kind, pre: `${hoisted} ${open}`, text, post: `\n${close}\nexport {};\n` });
  wrap('function', 'async function __sample(this: any) {', '}');
  wrap('class-body', 'class __Sample {', '}');
  wrap('object-body', 'const __sample = {', '};');
  wrap('expression', 'const __sample = (', ');', body.replace(/[;,]\s*$/, ''));
  wrap('interface-body', 'interface __Sample {', '}');
  return v;
}

// ---- custom checks (things the types cannot see) ----------------------------------------
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all']);
// The options app.METHOD(path, handler, options) applies (addRoute in src/moro.ts)
const DIRECT_FORM_OPTIONS = new Set([
  'validation',
  'rateLimit',
  'auth',
  'cache',
  'middleware',
  'description',
  'tags',
]);

/** Calls `report(node, code, message)` for each finding in a sample's source file. */
function customChecks(sf, report) {
  const visit = node => {
    // 9001: app.METHOD(path, handler, { ... }) with an option the direct form does not have.
    // The parameter is typed `any`, so the compiler cannot see it; at run time the option is
    // not applied (addRoute in src/moro.ts warns when the route is registered).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ROUTE_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 3
    ) {
      const [first, , options] = node.arguments;
      const receiver = node.expression.expression.getText(sf);
      if (
        ts.isObjectLiteralExpression(options) &&
        (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first)) &&
        /^(app|group|router|\w*[aA]pp)$/.test(receiver)
      ) {
        const keys = options.properties
          .map(p => p.name && p.name.getText(sf))
          .filter(k => k && !DIRECT_FORM_OPTIONS.has(k));
        if (keys.length) {
          const call = `${receiver}.${node.expression.name.text}(path, handler, options)`;
          report(
            options,
            9001,
            `direct-form route options [${keys.join(', ')}] are not options of ${call}`
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---- run --------------------------------------------------------------------------------
function run(docs, tmp) {
  const started = performance.now();

  // Sample files resolve third-party imports (zod, joi, ...) through the repo's
  // node_modules, and are ES modules like the package itself.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module","private":true}\n');

  const meta = new Map(); // sample path -> { doc, fence, kind, unparseable }
  const perDoc = new Map(); // doc -> counters
  for (const doc of docs) {
    const blocks = extract(doc.abs);
    perDoc.set(doc.rel, {
      samples: blocks.length,
      unparseable: 0,
      fiction: 0,
      allowed: 0,
      secondary: 0,
    });
    if (!blocks.length) continue;
    const dir = path.join(tmp, 'samples', doc.rel.replace(/\.md$/, ''));
    fs.mkdirSync(dir, { recursive: true });
    for (const b of blocks) {
      const candidates = variants(normalise(b.code));
      let chosen = candidates.find(v => parseErrors(`${v.pre}\n${v.text}${v.post}`) === 0);
      const unparseable = !chosen;
      if (unparseable) {
        chosen = candidates[0];
        perDoc.get(doc.rel).unparseable++;
      }
      // Line 0 is this header and line 1 is `pre`, so the sample's first line (doc line
      // fence + 1) is file line 2: doc line = fence + file line - 1.
      const header = `// SOURCE: ${doc.rel}:${b.line} (lang=${b.lang}; wrap=${chosen.kind}${
        unparseable ? '; UNPARSEABLE' : ''
      })`;
      const file = path.join(dir, `L${String(b.line).padStart(4, '0')}.ts`);
      fs.writeFileSync(file, `${header}\n${chosen.pre}\n${chosen.text}${chosen.post}`);
      meta.set(file, { doc: doc.rel, fence: b.line, kind: chosen.kind, unparseable });
    }
  }

  // Same strictness as tsconfig.json, plus the jest globals the testing samples use.
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    esModuleInterop: true,
    skipLibCheck: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    resolveJsonModule: true,
    noEmit: true,
    types: ['node', 'jest'],
    typeRoots: [path.join(ROOT, 'node_modules/@types')],
    paths: { '@morojs/moro': [path.join(ROOT, 'src/index.ts')] },
  };
  const roots = [...meta.keys(), path.join(SCRIPTS, 'doc-samples-preamble.d.ts')];
  let program = ts.createProgram(roots, options);

  // Pass 1: a sample that uses a name without declaring it gets an import for it when the
  // package root exports that name, so the use is checked against the real export.
  {
    const checker = program.getTypeChecker();
    const index = program.getSourceFile(path.join(ROOT, 'src/index.ts'));
    const exported = new Set(
      checker.getExportsOfModule(checker.getSymbolAtLocation(index)).map(s => s.name)
    );
    let changed = false;
    for (const file of meta.keys()) {
      const names = new Set();
      for (const d of program.getSemanticDiagnostics(program.getSourceFile(file))) {
        if (![2304, 2552, 2503, 2693].includes(d.code)) continue;
        const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        const m = /(?:name|namespace) '(\w+)'/.exec(text);
        if (m && exported.has(m[1])) names.add(m[1]);
      }
      if (!names.size) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines[0] += ` autoimport=${[...names].join(',')}`;
      lines[1] = `import { ${[...names].join(', ')} } from '@morojs/moro'; ${lines[1]}`;
      fs.writeFileSync(file, lines.join('\n'));
      changed = true;
    }
    if (changed) program = ts.createProgram(roots, options);
  }

  // Pass 2: collect and classify.
  const diags = [];
  for (const [file, m] of meta) {
    const sf = program.getSourceFile(file);
    const lines = sf.text.split('\n');
    const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line;
    const add = (line, code, cls, msg) =>
      diags.push({
        doc: m.doc,
        fence: m.fence,
        docLine: m.fence + line - 1,
        code,
        cls,
        msg,
        src: (lines[line] ?? '').trim(),
        sample: path.relative(tmp, file),
      });

    const syntactic = program.getSyntacticDiagnostics(sf);
    const brokenLines = new Set(syntactic.map(d => lineOf(d.start ?? 0)));
    for (const d of [...syntactic, ...program.getSemanticDiagnostics(sf)]) {
      const start = d.start ?? 0;
      const line = lineOf(start);
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      const span = sf.text.slice(start, start + (d.length ?? 0));
      let cls = 'noise';
      if (FICTION.has(d.code)) cls = 'fiction';
      else if (SECONDARY.has(d.code)) cls = 'secondary';
      // An unresolved module is fiction only when it is one of ours.
      if (d.code === 2307 && !/'@morojs\//.test(msg)) cls = 'noise';
      if (d.code >= 1000 && d.code < 2000) cls = 'syntax';
      // The sample means node:crypto, not the WebCrypto global.
      if (d.code === 2339 && /on type 'Crypto'/.test(msg)) cls = 'noise';
      // Strictness noise: env vars and request fields are `string | undefined`.
      if (
        (d.code === 2345 || d.code === 2769) &&
        /\| undefined' is not assignable/.test(msg) &&
        /process\.env|\benv\.|req\.(params|query|headers|cookies)\b/.test(span)
      ) {
        cls = 'noise';
      }
      // Elided placeholder arguments: fn({/* ... */}) / fn(/* ... */).
      if ([2345, 2554, 2555].includes(d.code) && /\/\* \.\.\. \*\//.test(lines[line] ?? '')) {
        cls = 'noise';
      }
      // A line the parser could not read (signature listings such as
      // `res.push(path: string, options?: {...})`): what the type checker says about the
      // recovered tree for that line is an artefact of the parse error, not a finding.
      if (cls === 'fiction' && brokenLines.has(line)) cls = 'syntax';
      add(line, d.code, cls, msg);
    }
    customChecks(sf, (node, code, msg) => add(lineOf(node.getStart(sf)), code, 'fiction', msg));
  }

  // Allow-list.
  const checked = new Set(docs.map(d => d.rel));
  const hits = ALLOW.map(() => []);
  for (const d of diags) {
    if (d.cls !== 'fiction') continue;
    const firstLine = d.msg.split('\n')[0];
    const i = ALLOW.findIndex(
      a =>
        a.code === d.code &&
        (!a.file || a.file === d.doc) &&
        a.message.test(firstLine) &&
        (!a.source || a.source.test(d.src))
    );
    if (i === -1) continue;
    d.cls = 'allowed';
    d.allow = i;
    hits[i].push(d);
  }
  // An entry can only be called stale when everything it could match was checked.
  const stale = ALLOW.filter(
    (a, i) => !hits[i].length && (a.file ? checked.has(a.file) : !opts.only)
  );

  for (const d of diags) {
    const c = perDoc.get(d.doc);
    if (d.cls === 'fiction') c.fiction++;
    else if (d.cls === 'allowed') c.allowed++;
    else if (d.cls === 'secondary') c.secondary++;
  }

  // Result files (only visible with --keep).
  const code = d => (d.code >= 9000 ? `DOC${d.code}` : `TS${d.code}`);
  const where = d => `${d.doc}:${d.docLine}`;
  const format = d =>
    `${where(d)} (sample at line ${d.fence}) ${code(d)} ${d.msg.split('\n')[0]}\n      | ${d.src}`;
  const byClass = cls => diags.filter(d => d.cls === cls);
  fs.writeFileSync(
    path.join(tmp, 'results.json'),
    JSON.stringify({ summary: Object.fromEntries(perDoc), diags }, null, 1)
  );
  for (const cls of ['fiction', 'allowed', 'secondary', 'syntax', 'noise']) {
    fs.writeFileSync(path.join(tmp, `${cls}.txt`), byClass(cls).map(format).join('\n') + '\n');
  }

  // Report.
  const total = { samples: 0, unparseable: 0, fiction: 0, allowed: 0, secondary: 0 };
  const width = Math.max(5, ...[...perDoc.keys()].map(k => k.length));
  const row = (name, c) =>
    console.log(
      name.padEnd(width),
      String(c.samples).padStart(7),
      String(c.unparseable).padStart(8),
      String(c.fiction).padStart(7),
      String(c.allowed).padStart(7),
      String(c.secondary).padStart(9)
    );
  console.log('file'.padEnd(width), 'samples', 'unparsed', 'fiction', 'allowed', 'secondary');
  for (const [name, c] of perDoc) {
    row(name, c);
    for (const k of Object.keys(total)) total[k] += c[k];
  }
  row('TOTAL', total);
  console.log(
    '\nfiction = API-fiction diagnostics not on the allow-list; allowed = on it;',
    'secondary = assignability diagnostics (not counted).'
  );

  const unparsed = [...meta.values()].filter(m => m.unparseable);
  if (unparsed.length) {
    console.log(
      `\nBlocks that do not parse (${unparsed.length}, e.g. signature listings; not a failure):`
    );
    console.log(`  ${unparsed.map(m => `${m.doc}:${m.fence}`).join('  ')}`);
  }

  const allowedCount = total.allowed;
  if (allowedCount) {
    console.log(`\nAllow-listed diagnostics (${allowedCount}):`);
    ALLOW.forEach((a, i) => {
      if (!hits[i].length) return;
      console.log(`  ${String(hits[i].length).padStart(3)} x ${a.reason}`);
      console.log(`        ${hits[i].map(where).join('  ')}`);
      if (opts.verbose) for (const d of hits[i]) console.log(`        ${format(d)}`);
    });
  }

  for (const a of stale) {
    const scope = a.file ?? 'any file';
    console.log(
      `\nwarning: stale allow-list entry: TS${a.code} ${a.message} in ${scope} matches nothing.` +
        `\n         (${a.reason})\n         Remove it from ALLOW in ${SELF}.`
    );
  }

  const fiction = byClass('fiction');
  if (fiction.length) {
    console.log(`\nAPI-fiction diagnostics (${fiction.length}):`);
    for (const d of fiction) console.log(`  ${format(d)}`);
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `\ndoc samples: ${total.samples} samples in ${perDoc.size} file${perDoc.size === 1 ? '' : 's'}; ` +
      `API-fiction diagnostics: ${fiction.length} (plus ${allowedCount} allow-listed); ` +
      `stale allow-list entries: ${stale.length}; ` +
      `blocks that do not parse: ${total.unparseable}; ${seconds}s`
  );
  if (fiction.length) {
    console.log(
      'FAILED: fix the sample, or add an ALLOW entry with a reason if it is a known non-defect.'
    );
  }
  return fiction.length ? 1 : 0;
}

const docs = listDocs(); // before the temp directory exists: a bad --only exits here
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-doc-samples-'));
try {
  process.exitCode = run(docs, tmp);
} finally {
  if (opts.keep) console.log(`kept: ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
