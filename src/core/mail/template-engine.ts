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

/**
 * Moro built-in template engine
 * Supports: {{variable}}, {{#if}}, {{#each}}, partials
 */
class MoroTemplateEngine implements TemplateEngineInterface {
  private compiled = new Map<string, (data: Record<string, any>) => string>();
  private partials = new Map<string, string>();

  async render(template: string, data: Record<string, any>): Promise<string> {
    // Replace partials first
    let processed = this.processPartials(template);

    // Process conditionals
    processed = this.processConditionals(processed, data);

    // Process loops
    processed = this.processLoops(processed, data);

    // Process variables
    processed = this.processVariables(processed, data);

    return processed;
  }

  compile(template: string): (data: Record<string, any>) => string {
    return (data: Record<string, any>) => {
      let processed = this.processPartials(template);
      processed = this.processConditionals(processed, data);
      processed = this.processLoops(processed, data);
      processed = this.processVariables(processed, data);
      return processed;
    };
  }

  registerPartial(name: string, template: string): void {
    this.partials.set(name, template);
  }

  private processPartials(template: string): string {
    return template.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_, name) => {
      return this.partials.get(name) || '';
    });
  }

  private processConditionals(template: string, data: Record<string, any>): string {
    return template.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
      (_, condition, truthy, falsy = '') => {
        const value = this.getValue(data, condition);
        return value ? truthy : falsy;
      }
    );
  }

  private processLoops(template: string, data: Record<string, any>): string {
    return template.replace(
      /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_, arrayName, body) => {
        const array = this.getValue(data, arrayName);

        if (!Array.isArray(array)) {
          return '';
        }

        return array
          .map((item: any) => {
            let itemBody = body;

            if (typeof item === 'object') {
              for (const [key, value] of Object.entries(item)) {
                const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                itemBody = itemBody.replace(regex, String(value));
              }
            } else {
              itemBody = itemBody.replace(/\{\{this\}\}/g, String(item));
            }

            return itemBody;
          })
          .join('');
      }
    );
  }

  private processVariables(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
      const value = this.getValue(data, key);
      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  private getValue(data: Record<string, any>, path: string): any {
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
}

/**
 * Main template engine manager
 */
export class TemplateEngineManager {
  private config: TemplateConfig;
  private engine: TemplateEngineInterface;
  private cache = new Map<string, any>();
  private engineType: TemplateEngine;

  constructor(config: TemplateConfig = {}) {
    this.config = {
      engine: 'moro',
      cache: true,
      ...config,
    };
    this.engineType = this.config.engine || 'moro';
    this.engine = this.createEngine(this.engineType);
  }

  /**
   * Create template engine instance
   */
  private createEngine(type: TemplateEngine): TemplateEngineInterface {
    if (type === 'moro') {
      return new MoroTemplateEngine();
    }

    throw new Error(`Template engine "${type}" will be lazy loaded when needed`);
  }

  /**
   * Render a template file with data
   */
  async renderFile(templateName: string, data: Record<string, any>): Promise<TemplateResult> {
    if (!this.config.path) {
      throw new Error('Template path not configured');
    }

    const cacheKey = `${templateName}:${this.engineType}`;

    if (!this.config.cache || !this.cache.has(cacheKey)) {
      const templatePath = path.join(this.config.path, `${templateName}.html`);

      try {
        const template = await fs.readFile(templatePath, 'utf-8');

        if (this.config.cache && this.engine.compile) {
          this.cache.set(cacheKey, this.engine.compile(template));
        }
      } catch {
        throw new Error(`Template file not found: ${templatePath}`);
      }
    }

    if (this.config.cache && this.cache.has(cacheKey)) {
      const compiled = this.cache.get(cacheKey);
      const html = compiled(data);
      return { html };
    }

    const templatePath = path.join(this.config.path, `${templateName}.html`);
    const template = await fs.readFile(templatePath, 'utf-8');
    const html = await this.engine.render(template, data);

    return { html };
  }

  /**
   * Render a template string with data
   */
  async renderString(template: string, data: Record<string, any>): Promise<string> {
    return await this.engine.render(template, data);
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
    }
  }

  /**
   * Register a helper function
   */
  registerHelper(name: string, fn: (...args: any[]) => any): void {
    if (this.engine.registerHelper) {
      this.engine.registerHelper(name, fn);
    }
  }

  /**
   * Register a partial template
   */
  registerPartial(name: string, template: string): void {
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
