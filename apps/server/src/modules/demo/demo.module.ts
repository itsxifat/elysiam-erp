import { Module } from '@nestjs/common';

import { DemoController } from './demo.controller.js';

/** The matrix's test subject. Removed in M06 — see demo.controller.ts. */
@Module({ controllers: [DemoController] })
export class DemoModule {}
