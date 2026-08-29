/**
 * rlh-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and shell services.
 */
import type { Context } from '@relay-harness/cordis';
import { type MarketConfig } from './routes.ts';
export declare const name = "rlh-market";
/** Optional cordis.yml configuration; profile defaults to `web`. */
export type Config = Partial<Pick<MarketConfig, 'profile' | 'allowRestart'>>;
export declare function apply(ctx: Context, config?: Config): void;
