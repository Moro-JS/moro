// Template Rendering Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createFrameworkLogger('TemplateCore');

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
  private deprecationWarned = false;

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

    // Handle HTML-escaped variable substitution: {{=variable}} (safe output)
    rendered = rendered.replace(/\{\{=([\w.]+)\}\}/g, (match: string, key: string) => {
      const value = key.split('.').reduce((obj: any, prop: string) => obj?.[prop], data);
      return value !== undefined ? escapeHtml(String(value)) : match;
    });

    // Handle basic variable substitution (unescaped — existing behavior preserved)
    rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
      if (data[key] !== undefined) {
        if (!this.deprecationWarned) {
          logger.warn(
            '[MoroJS Security] Template uses unescaped interpolation {{' +
              key +
              '}}. Use {{=' +
              key +
              '}} for HTML-escaped output. Raw interpolation will be deprecated in a future major version.',
            'TemplateCore'
          );
          this.deprecationWarned = true;
        }
        return String(data[key]);
      }
      return match;
    });

    // Handle nested object properties like {{user.name}} (unescaped — existing behavior)
    rendered = rendered.replace(/\{\{([\w.]+)\}\}/g, (match: string, key: string) => {
      const value = key.split('.').reduce((obj: any, prop: string) => obj?.[prop], data);
      return value !== undefined ? String(value) : match;
    });

    // Handle loops: {{#each items}}{{name}}{{/each}}
    rendered = rendered.replace(
      /\{\{#each (\w+)\}\}(.*?)\{\{\/each\}\}/gs,
      (match, arrayKey, template) => {
        const array = data[arrayKey];
        if (!Array.isArray(array)) return '';

        return array
          .map(item => {
            let itemTemplate = template;
            // Support {{=key}} (escaped) inside loops
            itemTemplate = itemTemplate.replace(
              /\{\{=([\w.]+)\}\}/g,
              (match: string, key: string) => {
                return item[key] !== undefined ? escapeHtml(String(item[key])) : match;
              }
            );
            // Support {{key}} (unescaped) inside loops
            itemTemplate = itemTemplate.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
              return item[key] !== undefined ? String(item[key]) : match;
            });
            return itemTemplate;
          })
          .join('');
      }
    );

    // Handle conditionals: {{#if condition}}content{{/if}}
    rendered = rendered.replace(
      /\{\{#if (\w+)\}\}(.*?)\{\{\/if\}\}/gs,
      (match, conditionKey, content) => {
        const condition = data[conditionKey];
        return condition ? content : '';
      }
    );

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
