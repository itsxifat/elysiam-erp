import 'reflect-metadata';

import { spawn } from 'node:child_process';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { currentDatabaseConfig } from '@elysium/db';
import type { Logger } from 'pino';

import { ALL_QUEUES } from './job-queues.js';
import { cameraEnv } from './modules/packing/camera/camera.config.js';
import { CameraProcessService } from './modules/packing/camera/camera-process.service.js';
import { CameraModule, registerCameraJobs } from './modules/packing/camera/camera.worker.js';
import { loadDeploymentBrand } from './platform/brand/deployment.js';
import { serverEnv } from './platform/config/env.js';
import { reportJobFailedThroughOutbox } from './platform/jobs/job-failed.js';
import { JobsRuntime } from './platform/jobs/jobs.runtime.js';
import { createLogger } from './platform/logging/logger.js';
import { reportError, shutdownObservability } from './platform/observability/errors.js';

/**
 * The camera process (M38c, D-672 to D-676): `node dist/main.camera.js`.
 *
 * Records every enabled IP camera of the brand (Orders → Pack → Settings → IP cameras) into a
 * rolling buffer on this server's disk with ffmpeg, and cuts each packing's video from it when
 * the packing closes (`packing.camera_cut`, enqueued by the finish). It runs beside the API and
 * the worker from the same image, on the same network as the cameras (the brand server's LAN),
 * because a browser cannot play RTSP and the recording must be on the server.
 *
 * It holds no owner role: it connects as the application role, enqueues and works jobs as a
 * pg-boss client (the worker installs the schema and the queues), and serves nothing.
 */

/** How often each loop runs. */
const RELOAD_MS = 10_000;
const REPORT_MS = 5_000;
const PRUNE_MS = 10_000;
const TIMEOUT_SWEEP_MS = 30_000;

async function startJobsClient(logger: Logger): Promise<JobsRuntime> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await JobsRuntime.start({
        role: 'client',
        connectionString: currentDatabaseConfig().DATABASE_URL,
        queues: ALL_QUEUES,
        logger,
      });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      logger.warn('jobs schema not ready; waiting for the worker to install it');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

/** Whether ffmpeg runs here, and which; said once at boot, never fatal (cameras say why). */
async function ffmpegVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(command, ['-hide_banner', '-version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code === 0 ? (out.split('\n')[0] ?? '') : null));
    } catch {
      resolve(null);
    }
  });
}

/** Run `work` every `ms`, one run at a time, logging (never throwing) what fails. */
function every(
  ms: number,
  name: string,
  work: () => Promise<unknown>,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  return (async () => {
    while (!signal.aborted) {
      try {
        await work();
      } catch (error) {
        // The message only: a database error never carries a camera's password, and the
        // recorder masks ffmpeg's own words before they get here.
        logger.error({ loop: name, reason: (error as Error).message }, 'camera loop failed');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  })();
}

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('camera');
  const config = cameraEnv();

  // One brand per deployment (D-470): refuse a database holding another real brand.
  const brand = await loadDeploymentBrand(env.ERP_BRAND_SLUG);
  if (brand !== null) logger.info({ brand: brand.slug }, 'brand deployment');

  const version = await ffmpegVersion(config.ffmpegPath);
  if (version === null) {
    logger.error('ffmpeg is not installed here; the cameras will report ffmpeg_missing');
  } else {
    logger.info({ ffmpeg: version }, 'ffmpeg found');
  }

  @Module({ imports: [CameraModule] })
  class CameraProcessModule {}

  const context = await NestFactory.createApplicationContext(CameraProcessModule, {
    logger: false,
    abortOnError: false,
  });

  const jobs = await startJobsClient(logger);
  const camera = context.get(CameraProcessService);
  camera.configure({
    bufferRoot: config.bufferDir,
    ffmpeg: { command: config.ffmpegPath },
    log: logger,
  });
  await camera.adoptBuffers();
  await registerCameraJobs({ jobs, camera, report: reportJobFailedThroughOutbox(logger) });

  const stopping = new AbortController();
  const loops = [
    every(RELOAD_MS, 'reload', () => camera.reload(), logger, stopping.signal),
    every(REPORT_MS, 'report', () => camera.reportAll(), logger, stopping.signal),
    every(PRUNE_MS, 'prune', () => camera.prune(), logger, stopping.signal),
    every(TIMEOUT_SWEEP_MS, 'timeouts', () => camera.closeTimedOut(), logger, stopping.signal),
  ];
  logger.info({ bufferDir: config.bufferDir }, 'ready');

  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        logger.info({ signal }, 'camera process shutting down');
        resolve();
      });
    }
  });

  stopping.abort();
  await Promise.all(loops);
  // A cut in progress finishes first (pg-boss's graceful stop), then the recorders stop.
  await jobs.stop();
  await camera.stopAll();
  await context.close();
  await shutdownObservability();
}

bootstrap().catch(async (error: unknown) => {
  process.stderr.write(`camera process failed to start: ${(error as Error).message}\n`);
  reportError(error, { kind: 'boot', process: 'camera' });
  await shutdownObservability();
  process.exit(1);
});
