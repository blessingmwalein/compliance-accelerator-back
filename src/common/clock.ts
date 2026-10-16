import { Injectable } from '@nestjs/common';

/** The time source of services. Tests override it, so no test depends on the real clock. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

/** Index of the fixed-size time bucket containing `now`: the stable part of a dedupe key that throttles repeats. */
export function timeBucket(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / (seconds * 1000));
}
