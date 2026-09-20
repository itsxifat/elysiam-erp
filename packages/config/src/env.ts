import { z } from 'zod';

/**
 * Parse `process.env` against a schema and fail fast with a readable report.
 *
 * Every app calls this once at startup. A missing or malformed variable stops
 * the process before it can serve a request against, say, the wrong database
 * (architecture §28).
 */
export function createEnv<TSchema extends z.ZodType>(
  appName: string,
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => {
        const key = issue.path.join('.') || '(root)';
        return `  ${key}: ${issue.message}`;
      })
      .sort()
      .join('\n');

    throw new Error(
      `Invalid environment for "${appName}":\n${problems}\n\n` +
        `Copy the app's .env.example to .env and fill in the missing values.`,
    );
  }

  return result.data;
}

/** Shared shape every app has. */
export const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
} as const;
