import { ModuleConfig } from '../../types/module';
import { DiscoveryOptions } from '../../types/discovery';
export declare class ModuleDiscovery {
  private baseDir;
  private options;
  constructor(baseDir?: string, options?: DiscoveryOptions);
  discoverModules(): Promise<ModuleConfig[]>;
  discoverModuleDirectories(modulesDir?: string): Promise<ModuleConfig[]>;
  private findModuleFiles;
  private scanDirectory;
  private loadModule;
  private isValidModule;
  watchModules(callback: (modules: ModuleConfig[]) => void): void;
}
export declare function autoDiscoverModules(
  baseDir?: string,
  options?: DiscoveryOptions
): Promise<ModuleConfig[]>;
export declare function autoDiscoverModuleDirectories(
  baseDir?: string,
  modulesDir?: string
): Promise<ModuleConfig[]>;
export declare class ModuleRegistry {
  private modules;
  private loadedModules;
  register(module: ModuleConfig): void;
  markLoaded(moduleName: string, version: string): void;
  isLoaded(moduleName: string, version: string): boolean;
  getModule(moduleName: string, version?: string): ModuleConfig | undefined;
  getAllModules(): ModuleConfig[];
  getLoadedModules(): ModuleConfig[];
  clear(): void;
}
