import { createRegistry } from './core/registry.js';
import { modules } from './modules/index.js';

export const buildRegistry = () => createRegistry(modules);
