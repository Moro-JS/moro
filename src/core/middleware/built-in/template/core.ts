// Template Rendering Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('TemplateMiddleware');

// `engine` selects nothing yet: say so once per process
let engineWarningShown = false;

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, char => ESCAPE_MAP[char] ?? char);
}

// Template grammar, scanned ONCE over the template source. A substituted value
// is appended to the output and never scanned, so nothing a value contains
// ({{x}}, {{{x}}}, {{#each}}, {{#if}}) is ever read as template syntax.
//
//   {{{path}}}          raw value (dotted paths allowed)
//   {{path}}            HTML-escaped value (dotted paths allowed)
//   {{#each key}}…{{/each}}   repeat the body for each item of the array `key`
//   {{#if key}}…{{/if}}       keep the body when `key` is truthy
//
// The triple-brace alternative comes first so the double-brace one cannot
// consume its inner braces. Blocks close at the FIRST matching close tag and a
// block tag that has no partner stays in the output as text.
const RE_TAG =
  /\{\{\{([\w.]+)\}\}\}|\{\{([\w.]+)\}\}|\{\{#each (\w+)\}\}|\{\{\/each\}\}|\{\{#if (\w+)\}\}|\{\{\/if\}\}/g;

interface TextToken {
  type: 'text';
  text: string;
}
/** {{path}} / {{{path}}}; `source` is emitted when the path resolves to nothing. */
interface VarToken {
  type: 'var';
  /** true for the triple-brace form: the value is not HTML-escaped */
  raw: boolean;
  path: string;
  source: string;
}
interface IfOpenToken {
  type: 'if';
  key: string;
  source: string;
}
interface IfCloseToken {
  type: 'endif';
  source: string;
}
type InlineToken = TextToken | VarToken | IfOpenToken | IfCloseToken;
interface EachBlock {
  type: 'each';
  key: string;
  body: InlineToken[];
}
type TemplateNode = InlineToken | EachBlock;

/** A template tokenised once; rendering never looks at the source again. */
export interface CompiledTemplate {
  nodes: TemplateNode[];
  /** False when the source has no {{#if}}/{{/if}} tag, so rendering can skip pairing. */
  hasConditionals: boolean;
}

type LexToken =
  InlineToken | { type: 'each'; key: string; source: string } | { type: 'endeach'; source: string };

function pushText(list: Array<TemplateNode | InlineToken>, text: string): void {
  if (text === '') return;
  const last = list[list.length - 1];
  if (last !== undefined && last.type === 'text') last.text += text;
  else list.push({ type: 'text', text });
}

/**
 * Tokenise template source. Block structure is fixed here, from the source
 * alone:
 *  - {{#each key}} pairs with the first {{/each}} after it. Inside that body
 *    another {{#each}} is plain text (loops do not nest), and an unpaired
 *    each tag is plain text.
 *  - {{#if}} / {{/if}} are kept as tokens and paired while rendering (see
 *    renderCompiledTemplate), because a conditional may enclose a loop.
 */
export function compileTemplate(source: string): CompiledTemplate {
  const tokens: LexToken[] = [];
  let hasConditionals = false;
  let lastIndex = 0;
  RE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RE_TAG.exec(source)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: source.slice(lastIndex, match.index) });
    }
    const tag = match[0];
    if (match[1] !== undefined) {
      tokens.push({ type: 'var', raw: true, path: match[1], source: tag });
    } else if (match[2] !== undefined) {
      tokens.push({ type: 'var', raw: false, path: match[2], source: tag });
    } else if (match[3] !== undefined) tokens.push({ type: 'each', key: match[3], source: tag });
    else if (match[4] !== undefined) {
      hasConditionals = true;
      tokens.push({ type: 'if', key: match[4], source: tag });
    } else if (tag === '{{/each}}') tokens.push({ type: 'endeach', source: tag });
    else {
      hasConditionals = true;
      tokens.push({ type: 'endif', source: tag });
    }
    lastIndex = match.index + tag.length;
  }
  if (lastIndex < source.length) tokens.push({ type: 'text', text: source.slice(lastIndex) });

  const nodes: TemplateNode[] = [];
  let moreCloses = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as LexToken;
    if (token.type === 'endeach') {
      pushText(nodes, token.source);
      continue;
    }
    if (token.type !== 'each') {
      if (token.type === 'text') pushText(nodes, token.text);
      else nodes.push(token);
      continue;
    }
    let close = -1;
    if (moreCloses) {
      for (let j = i + 1; j < tokens.length; j++) {
        if ((tokens[j] as LexToken).type === 'endeach') {
          close = j;
          break;
        }
      }
      if (close === -1) moreCloses = false;
    }
    if (close === -1) {
      pushText(nodes, token.source);
      continue;
    }
    const body: InlineToken[] = [];
    for (let j = i + 1; j < close; j++) {
      const inner = tokens[j] as LexToken;
      if (inner.type === 'text') pushText(body, inner.text);
      else if (inner.type === 'each' || inner.type === 'endeach') pushText(body, inner.source);
      else body.push(inner);
    }
    nodes.push({ type: 'each', key: token.key, body });
    i = close;
  }

  return { nodes, hasConditionals };
}

type Piece = string | IfOpenToken | IfCloseToken;

/**
 * Render a compiled template. Values go straight to the output:
 *  - a variable resolves against the render data; inside a loop body it falls
 *    back to the current item when the render data has no such path; a path
 *    that resolves to `undefined` leaves its tag in the output unchanged;
 *  - a loop over something that is not an array renders nothing;
 *  - {{#if key}} tests the render data (also inside a loop body) and pairs
 *    with the first {{/if}} that follows it in the rendered output.
 */
export function renderCompiledTemplate(compiled: CompiledTemplate, data: any): string {
  const pieces: Piece[] = [];

  const nodes = compiled.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as TemplateNode;
    switch (node.type) {
      case 'text':
        pieces.push(node.text);
        break;
      case 'var': {
        const value = resolveNestedValue(data, node.path);
        if (value === undefined) pieces.push(node.source);
        else pieces.push(node.raw ? String(value) : escapeHtml(String(value)));
        break;
      }
      case 'each': {
        const array = data[node.key];
        if (!Array.isArray(array)) break;
        const body = node.body;
        // forEach, like the map() it replaces, skips holes in sparse arrays.
        array.forEach(item => {
          for (let j = 0; j < body.length; j++) {
            const token = body[j] as InlineToken;
            if (token.type === 'text') {
              pieces.push(token.text);
            } else if (token.type === 'var') {
              let value = resolveNestedValue(data, token.path);
              if (value === undefined) value = resolveNestedValue(item, token.path);
              if (value === undefined) pieces.push(token.source);
              else pieces.push(token.raw ? String(value) : escapeHtml(String(value)));
            } else {
              pieces.push(token);
            }
          }
        });
        break;
      }
      default:
        pieces.push(node);
    }
  }

  if (!compiled.hasConditionals) return pieces.join('');

  // Pair conditionals over the rendered pieces. Only tokens that came from the
  // template source take part; value text is opaque here.
  let out = '';
  let moreCloses = true;
  let i = 0;
  while (i < pieces.length) {
    const piece = pieces[i] as Piece;
    if (typeof piece === 'string') {
      out += piece;
      i++;
      continue;
    }
    if (piece.type === 'endif') {
      out += piece.source;
      i++;
      continue;
    }
    let close = -1;
    if (moreCloses) {
      for (let j = i + 1; j < pieces.length; j++) {
        const candidate = pieces[j] as Piece;
        if (typeof candidate !== 'string' && candidate.type === 'endif') {
          close = j;
          break;
        }
      }
      if (close === -1) moreCloses = false;
    }
    if (close === -1) {
      out += piece.source;
      i++;
      continue;
    }
    if (data[piece.key]) {
      for (let j = i + 1; j < close; j++) {
        const inner = pieces[j] as Piece;
        out += typeof inner === 'string' ? inner : inner.source;
      }
    }
    i = close + 1;
  }
  return out;
}

function resolveNestedValue(obj: any, path: string): any {
  if (!path.includes('.')) return obj?.[path];
  return path.split('.').reduce((o: any, p: string) => o?.[p], obj);
}

export interface TemplateOptions {
  views: string;
  engine?: 'moro' | 'handlebars' | 'ejs';
  cache?: boolean;
  defaultLayout?: string;
}

export class TemplateCore {
  private views: string;
  private engine: string;
  private cache: boolean;
  private defaultLayout?: string | undefined;
  private templateCache = new Map<string, string>();
  private compiledCache = new Map<string, CompiledTemplate>();

  constructor(options: TemplateOptions) {
    this.views = path.resolve(options.views);
    this.engine = options.engine || 'moro';
    if (this.engine !== 'moro' && !engineWarningShown) {
      engineWarningShown = true;
      logger.warn(
        `middleware.template({ engine: '${this.engine}' }): the engine option is not applied. ` +
          'Views are rendered by the built-in engine ({{value}}, {{{raw}}}, {{#each}}, {{#if}}) ' +
          `from <views>/<name>.html, so ${this.engine} syntax reaches the client as written.`,
        'Template'
      );
    }
    this.cache = options.cache !== false;
    this.defaultLayout = options.defaultLayout;
  }

  addRenderMethod(req: HttpRequest, res: HttpResponse): void {
    res.render = async (template: string, data: any = {}) => {
      try {
        const templatePath = path.join(this.views, `${template}.html`);

        // Security: prevent directory traversal via user-controlled template names.
        const viewsWithSep = this.views.endsWith(path.sep) ? this.views : this.views + path.sep;
        if (!templatePath.startsWith(viewsWithSep)) {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return;
        }

        // Compiled once per template file when caching is on
        let compiled = this.cache ? this.compiledCache.get(templatePath) : undefined;
        if (compiled === undefined) {
          compiled = compileTemplate(await fs.readFile(templatePath, 'utf-8'));
          if (this.cache) {
            this.compiledCache.set(templatePath, compiled);
          }
        }

        let rendered = renderCompiledTemplate(compiled, data);

        // Handle layout
        if (this.defaultLayout) {
          rendered = await this.applyLayout(rendered, data);
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(rendered);
      } catch (error) {
        // The reason goes to the log whatever the environment; the client
        // gets it only outside production (an fs error names paths on disk).
        logger.error('Template rendering failed', 'Template', {
          template: String(template),
          error: error instanceof Error ? error.message : String(error),
        });
        const isProduction = process.env.NODE_ENV === 'production';
        res.status(500).json({
          success: false,
          error: 'Template rendering failed',
          ...(isProduction
            ? {}
            : { details: error instanceof Error ? error.message : String(error) }),
        });
      }
    };
  }

  private async applyLayout(content: string, _data: any): Promise<string> {
    const layoutPath = path.join(this.views, 'layouts', `${this.defaultLayout}.html`);
    try {
      let layoutContent: string;

      if (this.cache && this.templateCache.has(layoutPath)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        layoutContent = this.templateCache.get(layoutPath)!;
      } else {
        layoutContent = await fs.readFile(layoutPath, 'utf-8');
        if (this.cache) {
          this.templateCache.set(layoutPath, layoutContent);
        }
      }

      // Function replacement: a string replacement would expand `$&`, `$'`,
      // `` $` `` and `$$` found in the rendered page.
      return layoutContent.replace(/\{\{body\}\}/, () => content);
    } catch {
      // Layout not found, return content as-is
      return content;
    }
  }

  clearCache(): void {
    this.templateCache.clear();
    this.compiledCache.clear();
  }
}
