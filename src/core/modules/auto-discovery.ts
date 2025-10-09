// Auto-discovery system for Moro modules
import { readdirSync, statSync } from 'fs';
import { join, extname, relative, isAbsolute } from 'path';
import { ModuleConfig } from '../../types/module.js';
import { DiscoveryOptions } from '../../types/discovery.js';
import { ModuleDefaultsConfig } from '../../types/config.js';
import { createFrameworkLogger } from '../logger/index.js';

export class ModuleDiscovery {
  private baseDir: string;
  private options: DiscoveryOptions;
  private discoveryLogger = createFrameworkLogger('MODULE_DISCOVERY');
  private watchers: any[] = []; // Store file watchers for cleanup

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
          this.discoveryLogger.info(
            `Auto-discovered module: ${module.name}@${module.version} from ${modulePath}`
          );
        }
      } catch (error) {
        this.discoveryLogger.warn(`Failed to load module from ${modulePath}`, 'MODULE_DISCOVERY', {
          error: error instanceof Error ? error.message : String(error),
        });
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
                this.discoveryLogger.info(
                  `Auto-discovered module directory: ${module.name} from ${item}/`
                );
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
                    this.discoveryLogger.info(
                      `Auto-discovered module: ${module.name} from ${item}/${alt}`
                    );
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

  // Enhanced auto-discovery with advanced configuration
  async discoverModulesAdvanced(
    config: ModuleDefaultsConfig['autoDiscovery']
  ): Promise<ModuleConfig[]> {
    if (!config.enabled) {
      return [];
    }

    const allModules: ModuleConfig[] = [];

    // Discover from all configured paths
    for (const searchPath of config.paths) {
      const modules = await this.discoverFromPath(searchPath, config);
      allModules.push(...modules);
    }

    // Remove duplicates based on name@version
    const uniqueModules = this.deduplicateModules(allModules);

    // Sort modules based on load order strategy
    const sortedModules = this.sortModules(uniqueModules, config.loadOrder);

    // Validate dependencies if using dependency order
    if (config.loadOrder === 'dependency') {
      return this.resolveDependencyOrder(sortedModules);
    }

    return sortedModules;
  }

  // Discover modules from a specific path with advanced filtering
  private async discoverFromPath(
    searchPath: string,
    config: ModuleDefaultsConfig['autoDiscovery']
  ): Promise<ModuleConfig[]> {
    const modules: ModuleConfig[] = [];
    const fullPath = join(this.baseDir, searchPath);

    try {
      const stat = statSync(fullPath);

      if (!stat.isDirectory()) {
        return modules;
      }
    } catch (error) {
      return modules;
    }

    try {
      const files = await this.findMatchingFilesWithGlob(
        fullPath,
        config.patterns,
        config.ignorePatterns,
        config.maxDepth
      );

      for (const filePath of files) {
        try {
          // Convert relative path to absolute path for import
          const absolutePath = join(this.baseDir, filePath);
          const module = await this.loadModule(absolutePath);
          if (module && this.validateAdvancedModule(module, config)) {
            modules.push(module);
            this.discoveryLogger.info(
              `Auto-discovered module: ${module.name}@${module.version} from ${filePath}`
            );
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          if (config.failOnError) {
            throw new Error(`Failed to load module from ${filePath}: ${errorMsg}`);
          } else {
            this.discoveryLogger.warn(
              `Failed to load module from ${filePath}`,
              'MODULE_DISCOVERY',
              {
                error: errorMsg,
              }
            );
          }
        }
      }
    } catch (error) {
      if (config.failOnError) {
        throw error;
      }
      // Directory doesn't exist or other error, continue silently
    }

    return modules;
  }

  // Find files matching patterns with ignore support
  private findMatchingFiles(
    basePath: string,
    config: ModuleDefaultsConfig['autoDiscovery'],
    currentDepth: number = 0
  ): string[] {
    const files: string[] = [];

    if (currentDepth >= config.maxDepth) {
      return files;
    }

    try {
      const items = readdirSync(basePath);

      for (const item of items) {
        const fullPath = join(basePath, item);
        const relativePath = relative(this.baseDir, fullPath);

        // Check ignore patterns
        if (this.shouldIgnore(relativePath, config.ignorePatterns)) {
          continue;
        }

        const stat = statSync(fullPath);

        if (stat.isDirectory() && config.recursive) {
          files.push(...this.findMatchingFiles(fullPath, config, currentDepth + 1));
        } else if (stat.isFile()) {
          // Check if file matches any pattern
          if (this.matchesPatterns(relativePath, config.patterns)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Directory not accessible, skip
    }

    return files;
  }

  // Use native Node.js glob to find matching files
  private async findMatchingFilesWithGlob(
    searchPath: string,
    patterns: string[],
    ignorePatterns: string[],
    maxDepth: number = 5
  ): Promise<string[]> {
    // Force fallback in CI environments or if Node.js version is uncertain
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

    if (isCI) {
      return this.findMatchingFilesFallback(searchPath, patterns, ignorePatterns, maxDepth);
    }

    const allFiles: string[] = [];

    try {
      // Try to use native fs.glob if available (Node.js 20+)
      const { glob } = await import('fs/promises');

      // Check if glob is actually a function and test it
      if (typeof glob !== 'function') {
        return this.findMatchingFilesFallback(searchPath, patterns, ignorePatterns, maxDepth);
      }

      // Test glob with a simple pattern first
      try {
        const testIterator = glob(join(searchPath, '*'));
        let testCount = 0;
        for await (const _ of testIterator) {
          testCount++;
          if (testCount > 0) break; // Just test that it works
        }
      } catch (testError) {
        return this.findMatchingFilesFallback(searchPath, patterns, ignorePatterns, maxDepth);
      }

      for (const pattern of patterns) {
        const fullPattern = join(searchPath, pattern);
        try {
          // fs.glob returns an AsyncIterator, need to collect results
          const globIterator = glob(fullPattern);
          const files: string[] = [];

          for await (const file of globIterator) {
            const filePath = typeof file === 'string' ? file : (file as any).name || String(file);
            const relativePath = relative(this.baseDir, filePath);

            // Check if file should be ignored and within max depth
            if (
              !this.shouldIgnore(relativePath, ignorePatterns) &&
              this.isWithinMaxDepth(relativePath, searchPath, maxDepth)
            ) {
              files.push(relativePath);
            }
          }

          allFiles.push(...files);
        } catch (error) {
          // If any glob call fails, fall back to manual discovery
          this.discoveryLogger.warn(`Glob pattern failed: ${pattern}`, String(error));
          return this.findMatchingFilesFallback(searchPath, patterns, ignorePatterns, maxDepth);
        }
      }
    } catch (error) {
      // fs.glob not available, fall back to manual file discovery
      this.discoveryLogger.debug('Native fs.glob not available, using fallback');
      return this.findMatchingFilesFallback(searchPath, patterns, ignorePatterns, maxDepth);
    }

    return [...new Set(allFiles)]; // Remove duplicates
  }

  // Fallback for Node.js versions without fs.glob
  private async findMatchingFilesFallback(
    searchPath: string,
    patterns: string[],
    ignorePatterns: string[],
    maxDepth: number = 5
  ): Promise<string[]> {
    const config = {
      patterns,
      ignorePatterns,
      maxDepth,
      recursive: true,
    } as ModuleDefaultsConfig['autoDiscovery'];

    // Handle both absolute and relative paths
    const fullSearchPath = isAbsolute(searchPath) ? searchPath : join(this.baseDir, searchPath);

    // Check if search path exists
    try {
      const { access } = await import('fs/promises');
      await access(fullSearchPath);
    } catch (e) {
      return [];
    }

    // Get files and convert to relative paths
    const files = this.findMatchingFiles(fullSearchPath, config);
    const relativeFiles = files.map(file => relative(this.baseDir, file));

    return relativeFiles;
  }

  // Simple pattern matching for fallback (basic glob support)
  private matchesSimplePattern(path: string, pattern: string): boolean {
    try {
      // Normalize path separators
      const normalizedPath = path.replace(/\\/g, '/');
      const normalizedPattern = pattern.replace(/\\/g, '/');

      // Convert simple glob patterns to regex
      const regexPattern = normalizedPattern
        .replace(/\*\*/g, '___DOUBLESTAR___') // Temporarily replace ** BEFORE escaping
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex chars
        .replace(/\\\*/g, '[^/]*') // * matches anything except /
        .replace(/___DOUBLESTAR___/g, '.*') // ** matches anything including /
        .replace(/\\\?/g, '[^/]') // ? matches single character except /
        .replace(/\\\{([^}]+)\\\}/g, '($1)') // {ts,js} -> (ts|js)
        .replace(/,/g, '|'); // Convert comma to OR

      const regex = new RegExp(`^${regexPattern}$`, 'i');
      const result = regex.test(normalizedPath);

      return result;
    } catch (error) {
      this.discoveryLogger.warn(`Pattern matching error for "${pattern}": ${String(error)}`);
      return false;
    }
  }

  // Check if path should be ignored
  private shouldIgnore(path: string, ignorePatterns: string[]): boolean {
    return ignorePatterns.some(pattern => this.matchesSimplePattern(path, pattern));
  }

  // Check if path matches any of the patterns
  private matchesPatterns(path: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.matchesSimplePattern(path, pattern));
  }

  // Check if file is within max depth (for glob results)
  private isWithinMaxDepth(relativePath: string, searchPath: string, maxDepth: number): boolean {
    // Count directory separators to determine depth
    const pathFromSearch = relative(searchPath, join(this.baseDir, relativePath));
    const depth = pathFromSearch.split('/').length - 1; // -1 because file itself doesn't count as depth
    return depth <= maxDepth;
  }

  // Remove duplicate modules
  private deduplicateModules(modules: ModuleConfig[]): ModuleConfig[] {
    const seen = new Set<string>();
    return modules.filter(module => {
      const key = `${module.name}@${module.version}`;
      if (seen.has(key)) {
        this.discoveryLogger.warn(`Duplicate module found: ${key}`, 'MODULE_DISCOVERY');
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  // Sort modules based on strategy
  private sortModules(
    modules: ModuleConfig[],
    strategy: ModuleDefaultsConfig['autoDiscovery']['loadOrder']
  ): ModuleConfig[] {
    switch (strategy) {
      case 'alphabetical':
        return modules.sort((a, b) => a.name.localeCompare(b.name));

      case 'dependency':
        // Will be handled by resolveDependencyOrder
        return modules;

      case 'custom':
        // Allow custom sorting via module priority (if defined)
        return modules.sort((a, b) => {
          const aPriority = (a.config as any)?.priority || 0;
          const bPriority = (b.config as any)?.priority || 0;
          return bPriority - aPriority; // Higher priority first
        });

      default:
        return modules;
    }
  }

  // Resolve dependency order using topological sort
  private resolveDependencyOrder(modules: ModuleConfig[]): ModuleConfig[] {
    const moduleMap = new Map<string, ModuleConfig>();
    const dependencyGraph = new Map<string, string[]>();

    // Build module map and dependency graph
    modules.forEach(module => {
      const key = `${module.name}@${module.version}`;
      moduleMap.set(key, module);
      dependencyGraph.set(key, module.dependencies || []);
    });

    // Topological sort
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: ModuleConfig[] = [];

    const visit = (moduleKey: string): void => {
      if (visiting.has(moduleKey)) {
        throw new Error(`Circular dependency detected involving ${moduleKey}`);
      }

      if (visited.has(moduleKey)) {
        return;
      }

      visiting.add(moduleKey);

      const dependencies = dependencyGraph.get(moduleKey) || [];
      dependencies.forEach(dep => {
        // Find the dependency in our modules
        const depModule = Array.from(moduleMap.keys()).find(key =>
          key.startsWith(`${dep.split('@')[0]}@`)
        );
        if (depModule) {
          visit(depModule);
        }
      });

      visiting.delete(moduleKey);
      visited.add(moduleKey);

      const module = moduleMap.get(moduleKey);
      if (module) {
        sorted.push(module);
      }
    };

    // Visit all modules
    Array.from(moduleMap.keys()).forEach(key => {
      if (!visited.has(key)) {
        visit(key);
      }
    });

    return sorted;
  }

  // Enhanced module validation
  private validateAdvancedModule(
    module: ModuleConfig,
    _config: ModuleDefaultsConfig['autoDiscovery']
  ): boolean {
    // Basic validation
    if (!this.isValidModule(module)) {
      return false;
    }

    // Additional validation can be added here
    // For example, checking module compatibility, version constraints, etc.

    return true;
  }

  // Watch for module changes (for development)
  watchModules(callback: (modules: ModuleConfig[]) => void): void {
    // Use dynamic import for fs to avoid require()
    import('fs')
      .then(fs => {
        const modulePaths = this.findModuleFiles();

        modulePaths.forEach(path => {
          try {
            fs.watchFile(path, async () => {
              this.discoveryLogger.info(`Module file changed: ${path}`);
              const modules = await this.discoverModules();
              callback(modules);
            });
          } catch {
            // File watching not supported or failed
          }
        });
      })
      .catch(() => {
        // fs module not available
      });
  }

  // Watch modules with advanced configuration
  watchModulesAdvanced(
    config: ModuleDefaultsConfig['autoDiscovery'],
    callback: (modules: ModuleConfig[]) => void
  ): void {
    if (!config.watchForChanges) {
      return;
    }

    import('fs')
      .then(fs => {
        const watchedPaths = new Set<string>();

        // Watch all configured paths
        config.paths.forEach(searchPath => {
          const fullPath = join(this.baseDir, searchPath);

          try {
            if (statSync(fullPath).isDirectory() && !watchedPaths.has(fullPath)) {
              watchedPaths.add(fullPath);

              const watcher = fs.watch(
                fullPath,
                { recursive: config.recursive },
                async (eventType: string, filename: string | null) => {
                  if (filename && this.matchesPatterns(filename, config.patterns)) {
                    this.discoveryLogger.info(`Module file changed: ${filename}`);
                    const modules = await this.discoverModulesAdvanced(config);
                    callback(modules);
                  }
                }
              );

              // Store watcher for cleanup
              this.watchers.push(watcher);
            }
          } catch {
            // Path doesn't exist or not accessible
          }
        });
      })
      .catch(() => {
        // fs module not available
      });
  }

  // Clean up file watchers
  cleanup(): void {
    this.watchers.forEach(watcher => {
      if (watcher && typeof watcher.close === 'function') {
        watcher.close();
      }
    });
    this.watchers = [];
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
