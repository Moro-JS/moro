import { Container } from '../utilities';
import { ModuleConfig } from '../../types/module';
import { ModuleDefinition } from '../../types/module';
export declare function defineModule(definition: ModuleDefinition): ModuleConfig;
export declare class ModuleLoader {
  private container;
  constructor(container: Container);
  discoverModules(directory: string): Promise<ModuleConfig[]>;
  validateModule(config: ModuleConfig): boolean;
}
