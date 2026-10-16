import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './common/http/configure-app.js';
import type { EnvironmentVariables } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();

  const config: ConfigService<EnvironmentVariables, true> = app.get(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}

try {
  await bootstrap();
} catch (error) {
  // Logger may not exist yet (e.g. invalid environment), so write to stderr directly.
  console.error('Failed to start fca-backend:', error);
  process.exit(1);
}
