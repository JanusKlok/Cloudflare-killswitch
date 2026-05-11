import type { ServiceModule } from '../types.js';
import { workersModule } from './workers.js';
import { pagesModule } from './pages.js';
import { kvModule } from './kv.js';
import { r2Module } from './r2.js';
import { d1Module } from './d1.js';

// To add a new service: create src/metrics/<name>.ts exporting a ServiceModule,
// then append it here.  scheduled.ts does not need to change.
export const MODULES: ServiceModule[] = [
  workersModule,
  pagesModule,
  kvModule,
  r2Module,
  d1Module,
];
