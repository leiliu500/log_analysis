import { ApplicationRegistry } from '@log/shared';
import { scpApplication } from '@log/app-scp';
import { apiflcApplication } from '@log/app-apiflc';

/**
 * The installed applications, built once at the composition root. The analysis
 * engine is generic and receives this registry, routing each log to its owning
 * application's protocol. Onboarding a new application is: create its
 * `@log/app-*` package and add one `.register(...)` line here.
 */
export const applicationRegistry = new ApplicationRegistry()
  .register(scpApplication)
  .register(apiflcApplication);
