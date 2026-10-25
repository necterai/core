import type { Module } from './types.js';
import { createEnvironmentModule } from './collectors/index.js';
import { createProbesModule } from './probes/index.js';
import { createBehaviorModule } from './behavior/index.js';
import { createHarvestModule } from './harvest/index.js';
import { createCanaryModule } from './canary/index.js';
import { createExtensionModule } from './extension/index.js';
import { createConsistencyModule } from './consistency/index.js';

/** Default module set in boot order: cheap synchronous collectors first, behaviour last. */
export function defaultModules(): Module[] {
  return [
    createEnvironmentModule(),
    createProbesModule(),
    createConsistencyModule(),
    createExtensionModule(),
    createHarvestModule(),
    createCanaryModule(),
    createBehaviorModule(),
  ];
}
