import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CAMERA_SERVICE_ENV, cameraEnv, cameraProcessEnv } from './camera.config.js';

/**
 * The camera service's environment and network (M38c ledger audit, W4 and W5): the brand
 * compose file gives the camera process only what it uses, none of the brand's other secrets,
 * and a network that reaches Postgres and nothing else of the brand's; and the process starts
 * on exactly that.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.resolve(here, '../../../../../../infra/brand/docker-compose.brand.yml');

/** A service's block of the compose file: its lines, indented under `  <name>:`. */
function serviceBlock(name: string): string[] {
  const lines = readFileSync(COMPOSE, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** The variable names of a service's `environment:` map. */
function environmentOf(name: string): string[] {
  const block = serviceBlock(name);
  const start = block.findIndex((line) => line.trim() === 'environment:');
  const names: string[] = [];
  for (const line of block.slice(start + 1)) {
    const match = /^ {6}([A-Z0-9_<]+):/.exec(line);
    if (match === null) {
      if (/^ {6}#/.test(line)) continue;
      break;
    }
    names.push(match[1] ?? '');
  }
  return names;
}

describe('the camera service', () => {
  it('is given only what the camera process uses, none of the brand’s other secrets', () => {
    const names = environmentOf('camera');
    expect(names).not.toContain('<<');
    expect([...names].sort()).toEqual([...CAMERA_SERVICE_ENV].sort());
    for (const secret of [
      'AUTH_SECRET',
      'HR_FIELD_KEY',
      'COURIER_CREDENTIALS_KEY',
      'MARKETING_CREDENTIALS_KEY',
      'INTAKE_KEY_SECRET',
      'DATABASE_OWNER_URL',
      'VALKEY_URL',
      'OWNER_LINK_PUBLIC_KEY',
    ]) {
      expect(names).not.toContain(secret);
    }
  });

  it('sits on a network of its own with Postgres, not on the brand’s (no Valkey, Gotenberg or API)', () => {
    const networks = serviceBlock('camera').find((line) => line.trim().startsWith('networks:'));
    expect(networks?.trim()).toBe('networks: [camera]');
    const postgres = serviceBlock('postgres').find((line) => line.trim().startsWith('networks:'));
    expect(postgres?.trim()).toBe('networks: [default, camera]');
    for (const other of ['valkey', 'gotenberg', 'api', 'worker']) {
      const line = serviceBlock(other).find((entry) => entry.trim().startsWith('networks:'));
      expect(line ?? '', other).not.toContain('camera');
    }
  });

  it('starts on exactly that environment', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      ERP_BRAND_SLUG: 'elysium-lifestyle-bd',
      DATABASE_URL: 'postgres://erp_app:pw@postgres:5432/erp',
      STOREFRONT_CREDENTIALS_KEY: Buffer.alloc(32, 1).toString('base64'),
      STOREFRONT_CREDENTIALS_KEY_ID: 'k1',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: '/data/files',
      CAMERA_BUFFER_DIR: '/data/camera',
    };
    expect(cameraProcessEnv(env)).toMatchObject({
      DATABASE_URL: env.DATABASE_URL,
      ERP_BRAND_SLUG: 'elysium-lifestyle-bd',
    });
    expect(cameraEnv(env)).toEqual({ bufferDir: '/data/camera', ffmpegPath: 'ffmpeg' });
  });
});
