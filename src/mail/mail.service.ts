import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { sanitiseError } from '../jobs/backoff.js';
import { EmailDeliveriesRepository } from './email-deliveries.repository.js';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider.js';
import { renderMail, type MailRequest } from './mail-templates.js';

/**
 * Sends one templated message and records the attempt in `email_deliveries`. Called from job
 * handlers (never from the request path). A failed send is recorded and then thrown, so the job is
 * retried with backoff; the next attempt writes a new delivery row.
 */
@Injectable()
export class MailService {
  private readonly from: string;

  constructor(
    private readonly deliveries: EmailDeliveriesRepository,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.from = config.get('MAIL_FROM', { infer: true });
  }

  async send(request: MailRequest): Promise<void> {
    const delivery = await this.deliveries.create({
      toAddress: request.to,
      template: request.template,
    });
    try {
      const rendered = renderMail(request);
      const result = await this.provider.send({ to: request.to, from: this.from, ...rendered });
      await this.deliveries.markSent(delivery.id, result.providerMessageId);
    } catch (error) {
      await this.deliveries.markFailed(delivery.id, sanitiseError(error));
      throw error;
    }
  }
}
