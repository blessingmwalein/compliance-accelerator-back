import { Global, Module } from '@nestjs/common';
import { Clock } from './clock.js';

/** Global so every service gets the same injectable time source (tests override `Clock`). */
@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
