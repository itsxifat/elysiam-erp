/** Types for `preview-stack.mjs`, so the console's TypeScript e2e setup can import it. */

import type { ChildProcess, StdioOptions } from 'node:child_process';

export declare const REPO_ROOT: string;
export declare const PREVIEW_MARKER: string;

export interface PreviewDatabaseUrls {
  readonly database: string;
  readonly admin: string;
  readonly maintenance: string;
  readonly owner: string;
  readonly app: string;
  readonly analytics: string;
}

export interface PreviewPorts {
  readonly api: number;
  readonly console: number;
  readonly portal: number;
  readonly pos: number;
}

export declare function databaseUrls(database: string): PreviewDatabaseUrls;
export declare function postgresReady(urls: PreviewDatabaseUrls): Promise<boolean>;
export declare function databaseExists(urls: PreviewDatabaseUrls): Promise<boolean>;
export declare function recreateDatabase(urls: PreviewDatabaseUrls): Promise<void>;
export declare function dropDatabase(urls: PreviewDatabaseUrls): Promise<void>;
export declare function databaseEnv(urls: PreviewDatabaseUrls): Record<string, string>;
export declare function run(
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly stdio?: StdioOptions;
    readonly shell?: boolean;
  },
): Promise<void>;
export declare function pnpm(
  args: readonly string[],
  options?: { readonly cwd?: string; readonly env?: Record<string, string> },
): Promise<void>;
export declare function bootstrapAndMigrate(urls: PreviewDatabaseUrls): Promise<void>;
export declare function serverEnv(
  urls: PreviewDatabaseUrls,
  ports: PreviewPorts,
  extra?: Record<string, string>,
): Record<string, string>;
export declare function seedPreview(
  urls: PreviewDatabaseUrls,
  ports: PreviewPorts,
  options: {
    readonly out: string;
    readonly extraArgs?: readonly string[];
    readonly stdio?: StdioOptions;
    readonly env?: Record<string, string>;
  },
): Promise<void>;
export declare function portInUse(port: number): Promise<boolean>;
export declare function waitFor(url: string, timeoutMs: number): Promise<void>;
export declare function killTree(child: ChildProcess | undefined): void;
export declare function startStack(
  urls: PreviewDatabaseUrls,
  ports: PreviewPorts,
  options: { readonly logDir: string; readonly env?: Record<string, string> },
): ChildProcess[];
export declare function waitForStack(ports: PreviewPorts, timeoutMs?: number): Promise<void>;
