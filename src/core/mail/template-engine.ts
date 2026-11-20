// Email Template Engine
// ESM-first module with support for Moro, Handlebars, and EJS

import fs from 'fs/promises';
import path from 'path';
import type {
  TemplateConfig,
  TemplateEngineInterface,
  TemplateEngine,
  TemplateResult,
} from './types.js';
import { isPackageAvailable, resolveUserPackage } from '../utilities/package-utils.js';

// Template grammar, scanned ONCE over the template source (after partials are
// included). A substituted value is appended to the output and never scanned,
// so nothing a value contains ({{x}}, {{#each}}, {{#if}}, `$&`) is ever read
// as template syntax.
//
//   {{path}}                              value, HTML-escaped (dotted paths allowed)
//   {{{path}}}                            value, exactly as given
//   {{#if key}}…{{else}}…{{/if}}          keep one branch; {{else}} is optional
//   {{#each key}}…{{/each}}               repeat the body for each array item
//
// Blocks close at the FIRST matching close tag (they do not nest), and a block
// tag that has no partner stays in the output as text.
const RE_TAG =
  /\{\{\{(\w+(?:\.\w+)*)\}\}\}|\{\{(?:#if\s+(\w+)|#each\s+(\w+)|(\/if)|(\/each)|(\w+(?:\.\w+)*))\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const RE_HTML_SPECIAL = /[&<>"']/;
const RE_HTML_SPECIALS = /[&<>"']/g;

/** Escape a value for HTML text or a quoted attribute value. */
function escapeHtml(text: string): string {
  if (!RE_HTML_SPECIAL.test(text)) return text;
  return text.replace(RE_HTML_SPECIALS, char => HTML_ESCAPES[char] as string);
}

interface TextToken {
  type: 'text';
  text: string;
}
interface VarToken {
  type: 'var';
  path: string;
  /** {{{path}}}: the value is written without HTML escaping */
  raw: boolean;
}
interface EachOpenToken {
  type: 'each';
  key: string;
  source: string;
}
interface EachCloseToken {
  type: 'endeach';
  source: string;
}
/** What is left once the conditionals are decided. */
type Leaf = TextToken | VarToken | EachOpenToken | EachCloseToken;
interface Conditional {
  type: 'if';
  key: string;
  truthy: Leaf[];
  falsy: Leaf[];
}
type TemplateNode = Leaf | Conditional;
type LexToken =
  Leaf | { type: 'ifopen'; key: string; source: string } | { type: 'endif'; source: string };

interface CompiledTemplate {
  nodes: TemplateNode[];
  hasConditionals: boolean;
  hasLoops: boolean;
}

function pushText(list: Array<TemplateNode | Leaf>, text: string): void {
  if (text === '') return;
  const last = list[list.length - 1];
  if (last !== undefined && last.type === 'text') last.text += text;
  else list.push({ type: 'text', text });
}

/** Tokens between two conditional tags: a conditional inside one is plain text. */
function toLeaves(tokens: LexToken[], from: number, to: number): Leaf[] {
  const leaves: Leaf[] = [];
  for (let i = from; i < to; i++) {
    const token = tokens[i] as LexToken;
    if (token.type === 'text') pushText(leaves, token.text);
    else if (token.type === 'ifopen' || token.type === 'endif') pushText(leaves, token.source);
    else leaves.push(token);
  }
  return leaves;
}

/**
 * Tokenise template source. Conditional structure is fixed here, from the
 * source alone: {{#if key}} pairs with the first {{/if}} after it, split at
 * the first {{else}} in between. Loops are paired while rendering, because a
 * conditional branch may hold only one half of a loop.
 */
function compileTemplate(source: string): CompiledTemplate {
  const tokens: LexToken[] = [];
  let hasLoops = false;
  let lastIndex = 0;
  RE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RE_TAG.exec(source)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: source.slice(lastIndex, match.index) });
    }
    const tag = match[0];
    if (match[1] !== undefined) tokens.push({ type: 'var', path: match[1], raw: true });
    else if (match[2] !== undefined) tokens.push({ type: 'ifopen', key: match[2], source: tag });
    else if (match[3] !== undefined) {
      hasLoops = true;
      tokens.push({ type: 'each', key: match[3], source: tag });
    } else if (match[4] !== undefined) tokens.push({ type: 'endif', source: tag });
    else if (match[5] !== undefined) tokens.push({ type: 'endeach', source: tag });
    else tokens.push({ type: 'var', path: match[6] as string, raw: false });
    lastIndex = match.index + tag.length;
  }
  if (lastIndex < source.length) tokens.push({ type: 'text', text: source.slice(lastIndex) });

  const nodes: TemplateNode[] = [];
  let hasConditionals = false;
  let moreCloses = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as LexToken;
    if (token.type === 'endif') {
      pushText(nodes, token.source);
      continue;
    }
    if (token.type !== 'ifopen') {
      if (token.type === 'text') pushText(nodes, token.text);
      else nodes.push(token);
      continue;
    }
    let split = -1;
    let close = -1;
    if (moreCloses) {
      for (let j = i + 1; j < tokens.length; j++) {
        const candidate = tokens[j] as LexToken;
        if (candidate.type === 'endif') {
          close = j;
          break;
        }
        if (
          split === -1 &&
          candidate.type === 'var' &&
          !candidate.raw &&
          candidate.path === 'else'
        ) {
          split = j;
        }
      }
      if (close === -1) moreCloses = false;
    }
    if (close === -1) {
      pushText(nodes, token.source);
      continue;
    }
    hasConditionals = true;
    nodes.push({
      type: 'if',
      key: token.key,
      truthy: toLeaves(tokens, i + 1, split === -1 ? close : split),
      falsy: split === -1 ? [] : toLeaves(tokens, split + 1, close),
    });
    i = close;
  }

  return { nodes, hasConditionals, hasLoops };
}

function getValue(data: Record<string, any>, path: string): any {
  const keys = path.split('.');
  let value: any = data;

  for (const key of keys) {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    value = value[key];
  }

  return value;
}

function renderValue(data: Record<string, any>, path: string): string {
  const value = getValue(data, path);
  return value !== undefined && value !== null ? String(value) : '';
}

/**
 * Inside a loop body: an object item supplies {{key}} for each of its own
 * keys, any other item supplies {{this}}; everything else comes from the
 * render data.
 */
function renderItemValue(data: Record<string, any>, item: any, path: string): string {
  if (typeof item === 'object') {
    if (
      Object.prototype.hasOwnProperty.call(item, path) &&
      Object.prototype.propertyIsEnumerable.call(item, path)
    ) {
      return String(item[path]);
    }
  } else if (path === 'this') {
    return String(item);
  }
  return renderValue(data, path);
}

/** A value as it goes into the output: escaped unless the tag was {{{…}}}. */
function writeValue(text: string, token: VarToken): string {
  return token.raw ? text : escapeHtml(text);
}

/** Render a compiled template. Values go to the output and are never scanned. */
function renderCompiledTemplate(compiled: CompiledTemplate, data: Record<string, any>): string {
  let leaves: Leaf[];
  if (compiled.hasConditionals) {
    leaves = [];
    for (const node of compiled.nodes) {
      if (node.type !== 'if') leaves.push(node);
      else
        for (const leaf of getValue(data, node.key) ? node.truthy : node.falsy) leaves.push(leaf);
    }
  } else {
    leaves = compiled.nodes as Leaf[];
  }

  let out = '';
  let moreCloses = compiled.hasLoops;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i] as Leaf;
    if (leaf.type === 'text') {
      out += leaf.text;
      continue;
    }
    if (leaf.type === 'var') {
      out += writeValue(renderValue(data, leaf.path), leaf);
      continue;
    }
    if (leaf.type === 'endeach') {
      out += leaf.source;
      continue;
    }

    // {{#each key}}: pairs with the first {{/each}} that follows it
    let close = -1;
    if (moreCloses) {
      for (let j = i + 1; j < leaves.length; j++) {
        if ((leaves[j] as Leaf).type === 'endeach') {
          close = j;
          break;
        }
      }
      if (close === -1) moreCloses = false;
    }
    if (close === -1) {
      out += leaf.source;
      continue;
    }

    const array = getValue(data, leaf.key);
    if (Array.isArray(array)) {
      const first = i + 1;
      // forEach, like the map() it replaces, skips holes in sparse arrays
      array.forEach((item: any) => {
        for (let j = first; j < close; j++) {
          const inner = leaves[j] as Leaf;
          if (inner.type === 'text') out += inner.text;
          else if (inner.type === 'var') {
            out += writeValue(renderItemValue(data, item, inner.path), inner);
          } else out += inner.source;
        }
      });
    }
    i = close;
  }
  return out;
}

/**
 * Moro built-in template engine
 * Supports: {{variable}} (HTML-escaped), {{{variable}}} (as given), {{#if}},
 * {{#each}}, partials
 */
class MoroTemplateEngine implements TemplateEngineInterface {
  private partials = new Map<string, string>();
  // Bumped when a partial is registered, so a compiled template picks it up
  private partialsVersion = 0;

  async render(template: string, data: Record<string, any>): Promise<string> {
    return renderCompiledTemplate(compileTemplate(this.processPartials(template)), data);
  }

  compile(template: string): (data: Record<string, any>) => string {
    let compiled: CompiledTemplate | undefined;
    let version = -1;
    return (data: Record<string, any>) => {
      if (compiled === undefined || version !== this.partialsVersion) {
        version = this.partialsVersion;
        compiled = compileTemplate(this.processPartials(template));
      }
      return renderCompiledTemplate(compiled, data);
    };
  }

  registerPartial(name: string, template: string): void {
    this.partials.set(name, template);
    this.partialsVersion++;
  }

  // Partials are included in the template source before it is tokenised
  private processPartials(template: string): string {
    return template.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_, name) => {
      return this.partials.get(name) || '';
    });
  }
}

const TEMPLATE_ENGINES: readonly TemplateEngine[] = ['moro', 'handlebars', 'ejs'];

/**
 * Main template engine manager
 */
export class TemplateEngineManager {
  private config: TemplateConfig;
  // null until an external engine ('handlebars' / 'ejs') has been imported
  private engine: TemplateEngineInterface | null;
  private cache = new Map<string, any>();
  private engineType: TemplateEngine;
  private pendingHelpers: Array<[string, (...args: any[]) => any]> = [];
  private pendingPartials: Array<[string, string]> = [];

  constructor(config: TemplateConfig = {}) {
    this.config = {
      engine: 'moro',
      cache: true,
      ...config,
    };
    this.engineType = this.config.engine || 'moro';
    if (!TEMPLATE_ENGINES.includes(this.engineType)) {
      throw new Error(
        `Unknown template engine "${this.engineType}". Use 'moro', 'handlebars' or 'ejs'.`
      );
    }
    // 'handlebars' and 'ejs' are optional packages, imported on first use
    // (see ensureEngine): a constructor cannot await the import.
    this.engine = this.engineType === 'moro' ? new MoroTemplateEngine() : null;
  }

  /**
   * The engine to render with. An external engine is imported the first time
   * it is needed, unless loadExternalEngine() has already done so.
   */
  private async ensureEngine(): Promise<TemplateEngineInterface> {
    if (!this.engine) {
      await this.loadExternalEngine(this.engineType);
    }
    return this.engine as TemplateEngineInterface;
  }

  /**
   * Render a template file with data
   */
  async renderFile(templateName: string, data: Record<string, any>): Promise<TemplateResult> {
    if (!this.config.path) {
      throw new Error('Template path not configured');
    }

    // A template is a file inside the template directory (subdirectories
    // included). A name that leads anywhere else is refused before any read.
    const root = path.resolve(this.config.path);
    const templatePath = path.resolve(root, `${templateName}.html`);
    const relative = path.relative(root, templatePath);
    if (
      typeof templateName !== 'string' ||
      templateName.includes('\0') ||
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Template name ${JSON.stringify(templateName)} is outside the template directory`
      );
    }

    const engine = await this.ensureEngine();
    const cacheKey = `${templateName}:${this.engineType}`;

    if (this.config.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { html: cached(data) };
      }
    }

    let template: string;
    try {
      template = await fs.readFile(templatePath, 'utf-8');
    } catch {
      throw new Error(`Template file not found: ${templatePath}`);
    }

    if (this.config.cache && engine.compile) {
      const compiled = engine.compile(template);
      this.cache.set(cacheKey, compiled);
      return { html: compiled(data) };
    }

    return { html: await engine.render(template, data) };
  }

  /**
   * Render a template string with data
   */
  async renderString(template: string, data: Record<string, any>): Promise<string> {
    const engine = await this.ensureEngine();
    return await engine.render(template, data);
  }

  /**
   * Load external template engine (Handlebars, EJS)
   */
  async loadExternalEngine(type: TemplateEngine): Promise<void> {
    if (type === 'moro') {
      return;
    }

    if (type === 'handlebars') {
      if (!isPackageAvailable('handlebars')) {
        throw new Error(
          'Handlebars is not installed.\n' + 'Install it with: npm install handlebars'
        );
      }

      const handlebarsPath = resolveUserPackage('handlebars');
      const Handlebars = await import(handlebarsPath);

      this.engine = {
        render: async (template: string, data: Record<string, any>) => {
          const compiledTemplate = Handlebars.default.compile(template);
          return compiledTemplate(data);
        },
        compile: (template: string) => {
          return Handlebars.default.compile(template);
        },
        registerHelper: (name: string, fn: (...args: any[]) => any) => {
          Handlebars.default.registerHelper(name, fn);
        },
        registerPartial: (name: string, template: string) => {
          Handlebars.default.registerPartial(name, template);
        },
      };
    } else if (type === 'ejs') {
      if (!isPackageAvailable('ejs')) {
        throw new Error('EJS is not installed.\n' + 'Install it with: npm install ejs');
      }

      const ejsPath = resolveUserPackage('ejs');
      const ejs = await import(ejsPath);

      this.engine = {
        render: async (template: string, data: Record<string, any>) => {
          return ejs.default.render(template, data);
        },
        compile: (template: string) => {
          return ejs.default.compile(template);
        },
      };
    } else {
      return;
    }

    // Compiled templates are cached per engine
    this.engineType = type;

    // Helpers and partials registered before the package was imported
    for (const [name, fn] of this.pendingHelpers.splice(0)) {
      this.registerHelper(name, fn);
    }
    for (const [name, template] of this.pendingPartials.splice(0)) {
      this.registerPartial(name, template);
    }
  }

  /**
   * Register a helper function
   */
  registerHelper(name: string, fn: (...args: any[]) => any): void {
    if (!this.engine) {
      this.pendingHelpers.push([name, fn]);
      return;
    }
    if (this.engine.registerHelper) {
      this.engine.registerHelper(name, fn);
    }
  }

  /**
   * Register a partial template
   */
  registerPartial(name: string, template: string): void {
    if (!this.engine) {
      this.pendingPartials.push([name, template]);
      return;
    }
    if (this.engine.registerPartial) {
      this.engine.registerPartial(name, template);
    }
  }

  /**
   * Clear template cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Load partials from directory
   */
  async loadPartials(): Promise<void> {
    if (!this.config.partials) {
      return;
    }

    try {
      const files = await fs.readdir(this.config.partials);

      for (const file of files) {
        if (file.endsWith('.html')) {
          const name = file.replace('.html', '');
          const content = await fs.readFile(path.join(this.config.partials, file), 'utf-8');
          this.registerPartial(name, content);
        }
      }
    } catch {
      // Partials directory doesn't exist or can't be read
    }
  }
}
