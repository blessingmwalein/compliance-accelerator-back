import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailTransport, NodeEnv, type EnvironmentVariables } from '../config/env.schema.js';
import { EmailDeliveriesRepository } from './email-deliveries.repository.js';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider.js';
import { FileMailTransport } from './file-mail-transport.js';
import { MailService } from './mail.service.js';

@Module({
  providers: [
    EmailDeliveriesRepository,
    MailService,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): EmailProvider => {
        const production = config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
        // Only the file transport exists until the provider is chosen at gate G0 (SMTP/ESP, SPF/DKIM).
        if (config.get('MAIL_TRANSPORT', { infer: true }) === MailTransport.File) {
          if (production) {
            new Logger('MailModule').warn(
              'MAIL_TRANSPORT=file in production: emails are written to disk and NOT delivered. Choose a provider (gate G0).',
            );
          }
          return new FileMailTransport(config.get('DEV_MAIL_DIR', { infer: true }), !production);
        }
        throw new Error('Unsupported MAIL_TRANSPORT');
      },
    },
  ],
  exports: [MailService],
})
export class MailModule {}
