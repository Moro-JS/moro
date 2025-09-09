// Auto-discovery system for Moro modules
import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { ModuleConfig } from '../../types/module';
import { DiscoveryOptions } from '../../types/discovery';

export class ModuleDiscovery {
  private baseDir: string;
  private options: DiscoveryOptions;

  constructor(baseDir: string = process.cwd(), options: DiscoveryOptions = {}) {
    this.baseDir = baseDir;
    this.options = {
      pattern: /\.(module|config)\.(ts|js)$/,
      recursive: true,
      extensions: ['.ts', '.js'],
      ...options,
    };
  }

  // Auto-discover modules in the filesystem
  async discoverModules(): Promise<ModuleConfig[]> {
    const modules: ModuleConfig[] = [];
    const modulePaths = this.findModuleFiles();

    for (const modulePath of modulePaths) {
      try {
        const module = await this.loadModule(modulePath);
        if (module) {
          modules.push(module);
          console.log(
            `Auto-discovered module: ${module.name}@${module.version} from ${modulePath}`
          );
        }
      } catch (error) {
        console.warn(`Failed to load module from ${modulePath}:`, error);
      }
    }

    return modules;
  }

  // Find modules by directory structure
  async discoverModuleDirectories(modulesDir: string = 'src/modules'): Promise<ModuleConfig[]> {
    const modules: ModuleConfig[] = [];
    const fullPath = join(this.baseDir, modulesDir);

    try {
      if (!statSync(fullPath).isDirectory()) {
        return modules;
      }

      const items = readdirSync(fullPath);

      for (const item of items) {
        const itemPath = join(fullPath, item);

        if (statSync(itemPath).isDirectory()) {
          const indexPath = join(itemPath, 'index.ts');

          try {
            if (statSync(indexPath).isFile()) {
              const module = await this.loadModule(indexPath);
              if (module) {
                modules.push(module);
                console.log(`Auto-discovered module directory: ${module.name} from ${item}/`);
              }
            }
          } catch {
            // Try alternate patterns
            const alternates = ['module.ts', `${item}.module.ts`, 'config.ts'];

            for (const alt of alternates) {
              const altPath = join(itemPath, alt);
              try {
                if (statSync(altPath).isFile()) {
                  const module = await this.loadModule(altPath);
                  if (module) {
                    modules.push(module);
                    console.log(`Auto-discovered module: ${module.name} from ${item}/${alt}`);
                    break;
                  }
                }
              } catch {
                // Continue trying
              }
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist, that's fine
    }

    return modules;
  }

  // Find all module files matching the pattern
  private findModuleFiles(): string[] {
    const files: string[] = [];
    this.scanDirectory(this.baseDir, files);
    return files.filter(file => this.options.pattern?.test(file));
  }

  // Recursively scan directories for module files
  private scanDirectory(dir: string, files: string[]): void {
    try {
      const items = readdirSync(dir);

      for (const item of items) {
        const fullPath = join(dir, item);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules and other common directories
          if (!['node_modules', '.git', 'dist', 'build'].includes(item) && this.options.recursive) {
            this.scanDirectory(fullPath, files);
          }
        } else if (stat.isFile()) {
          const ext = extname(item);
          if (this.options.extensions?.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Directory not accessible, skip
    }
  }

  // Load a module from a file path
  private async loadModule(modulePath: string): Promise<ModuleConfig | null> {
    try {
      const module = await import(modulePath);

      // Try different export patterns
      const candidates = [
        module.default,
        module.module,
        module.config,
        module,
        ...Object.values(module).filter(
          exp => exp && typeof exp === 'object' && 'name' in exp && 'version' in exp
        ),
      ];

      for (const candidate of candidates) {
        if (this.isValidModule(candidate)) {
          return candidate as ModuleConfig;
        }
      }

      return null;
    } catch (error) {
      throw new Error(`Failed to import module: ${(error as Error).message}`);
    }
  }

  // Validate that an object is a valid ModuleConfig
  private isValidModule(obj: any): boolean {
    return (
      obj &&
      typeof obj === 'object' &&
      typeof obj.name === 'string' &&
      typeof obj.version === 'string' &&
      (obj.routes === undefined || Array.isArray(obj.routes)) &&
      (obj.websockets === undefined || Array.isArray(obj.websockets)) &&
      (obj.services === undefined || Array.isArray(obj.services))
    );
  }

  // Watch for module changes (for development)
  watchModules(callback: (modules: ModuleConfig[]) => void): void {
    const fs = require('fs');
    const modulePaths = this.findModuleFiles();

    modulePaths.forEach(path => {
      try {
        fs.watchFile(path, async () => {
          console.log(`Module file changed: ${path}`);
          const modules = await this.discoverModules();
          callback(modules);
        });
      } catch {
        // File watching not supported or failed
      }
    });
  }
}

// Convenience functions
export async function autoDiscoverModules(
  baseDir?: string,
  options?: DiscoveryOptions
): Promise<ModuleConfig[]> {
  const discovery = new ModuleDiscovery(baseDir, options);
  return discovery.discoverModules();
}

export async function autoDiscoverModuleDirectories(
  baseDir?: string,
  modulesDir?: string
): Promise<ModuleConfig[]> {
  const discovery = new ModuleDiscovery(baseDir);
  return discovery.discoverModuleDirectories(modulesDir);
}

// Module registry for tracking loaded modules
export class ModuleRegistry {
  private modules = new Map<string, ModuleConfig>();
  private loadedModules = new Set<string>();

  register(module: ModuleConfig): void {
    const key = `${module.name}@${module.version}`;
    this.modules.set(key, module);
  }

  markLoaded(moduleName: string, version: string): void {
    const key = `${moduleName}@${version}`;
    this.loadedModules.add(key);
  }

  isLoaded(moduleName: string, version: string): boolean {
    const key = `${moduleName}@${version}`;
    return this.loadedModules.has(key);
  }

  getModule(moduleName: string, version?: string): ModuleConfig | undefined {
    if (version) {
      return this.modules.get(`${moduleName}@${version}`);
    }

    // Find latest version if no version specified
    const modules = Array.from(this.modules.entries())
      .filter(([key]) => key.startsWith(`${moduleName}@`))
      .sort(([a], [b]) => b.localeCompare(a)); // Sort by version desc

    return modules[0]?.[1];
  }

  getAllModules(): ModuleConfig[] {
    return Array.from(this.modules.values());
  }

  getLoadedModules(): ModuleConfig[] {
    return Array.from(this.modules.entries())
      .filter(([key]) => this.loadedModules.has(key))
      .map(([, module]) => module);
  }

  clear(): void {
    this.modules.clear();
    this.loadedModules.clear();
  }
}
