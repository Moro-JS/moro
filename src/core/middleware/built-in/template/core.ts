// Template Rendering Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, char => ESCAPE_MAP[char]);
}

// Pre-compiled regex patterns — avoids recompilation on every render call.
// Triple-brace {{{var}}} is raw output; double-brace {{var}} is HTML-escaped.
// Triple MUST be matched before double to avoid double consuming its braces.
const RE_RAW_VAR = /\{\{\{([\w.]+)\}\}\}/g;
const RE_VAR = /\{\{([\w.]+)\}\}/g;
const RE_EACH_BLOCK = /\{\{#each (\w+)\}\}(.*?)\{\{\/each\}\}/gs;
const RE_IF_BLOCK = /\{\{#if (\w+)\}\}(.*?)\{\{\/if\}\}/gs;

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
  private defaultLayout?: string;
  private templateCache = new Map<string, string>();

  constructor(options: TemplateOptions) {
    this.views = path.resolve(options.views);
    this.engine = options.engine || 'moro';
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

        let templateContent: string;

        // Check cache first
        if (this.cache && this.templateCache.has(templatePath)) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          templateContent = this.templateCache.get(templatePath)!;
        } else {
          templateContent = await fs.readFile(templatePath, 'utf-8');
          if (this.cache) {
            this.templateCache.set(templatePath, templateContent);
          }
        }

        // Render based on engine
        let rendered = this.renderTemplate(templateContent, data);

        // Handle layout
        if (this.defaultLayout) {
          rendered = await this.applyLayout(rendered, data);
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(rendered);
      } catch (error) {
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

  private renderTemplate(content: string, data: any): string {
    let rendered = content;

    // Raw output: {{{variable}}} — inserted verbatim. Must run before {{var}}
    // so the outer braces of the triple form aren't consumed as a double match.
    rendered = rendered.replace(RE_RAW_VAR, (match: string, key: string) => {
      const value = resolveNestedValue(data, key);
      return value !== undefined ? String(value) : match;
    });

    // Default: {{variable}} is HTML-escaped (Mustache/Handlebars convention).
    rendered = rendered.replace(RE_VAR, (match: string, key: string) => {
      const value = resolveNestedValue(data, key);
      return value !== undefined ? escapeHtml(String(value)) : match;
    });

    // Handle loops: {{#each items}}{{name}}{{/each}}
    rendered = rendered.replace(RE_EACH_BLOCK, (match, arrayKey, template) => {
      const array = data[arrayKey];
      if (!Array.isArray(array)) return '';

      return array
        .map(item => {
          let itemTemplate = template;
          // {{{key}}} raw inside loops
          itemTemplate = itemTemplate.replace(RE_RAW_VAR, (match: string, key: string) => {
            const value = resolveNestedValue(item, key);
            return value !== undefined ? String(value) : match;
          });
          // {{key}} escaped inside loops
          itemTemplate = itemTemplate.replace(RE_VAR, (match: string, key: string) => {
            const value = resolveNestedValue(item, key);
            return value !== undefined ? escapeHtml(String(value)) : match;
          });
          return itemTemplate;
        })
        .join('');
    });

    // Handle conditionals: {{#if condition}}content{{/if}}
    rendered = rendered.replace(RE_IF_BLOCK, (match, conditionKey, content) => {
      const condition = data[conditionKey];
      return condition ? content : '';
    });

    return rendered;
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

      return layoutContent.replace(/\{\{body\}\}/, content);
    } catch {
      // Layout not found, return content as-is
      return content;
    }
  }

  clearCache(): void {
    this.templateCache.clear();
  }
}
