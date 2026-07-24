import type { GoldCase } from '@log/shared';
import { scpGoldCases } from '@log/app-scp/backtest';
import { apiflcGoldCases } from '@log/app-apiflc/backtest';

/**
 * The full gold-set corpus, assembled from each application's OWN cases. The cases
 * and their fixtures live in the app packages (`@log/app-scp`, `@log/app-apiflc`) via
 * their `./backtest` subpath — this dev-only package is the single place that
 * aggregates them, so no app-specific data leaks into shared or into the production
 * bundle. Onboarding an app to the backtest is one import + spread here.
 */
export const corpus: GoldCase[] = [...scpGoldCases, ...apiflcGoldCases];
