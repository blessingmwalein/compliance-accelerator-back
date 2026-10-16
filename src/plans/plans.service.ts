import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { PlansRepository, type PlanRecord } from './plans.repository.js';
import type { PlanDto, UpdatePlanVisibilityDto } from './plans.dto.js';

const toDto = (record: PlanRecord): PlanDto => ({ ...record });

@Injectable()
export class PlansService {
  constructor(private readonly plans: PlansRepository) {}

  async listVisible(): Promise<PlanDto[]> {
    return (await this.plans.list({ visibleOnly: true })).map(toDto);
  }

  /** Every plan including hidden ones (platform administrators only). */
  async listAll(): Promise<PlanDto[]> {
    return (await this.plans.list({ visibleOnly: false })).map(toDto);
  }

  /**
   * Shows or hides a plan. This changes what is OFFERED, nothing else: organisations that already have
   * the plan keep their entitlements (they are snapshots).
   */
  async setVisibility(id: string, dto: UpdatePlanVisibilityDto): Promise<PlanDto> {
    const current = await this.plans.findById(id);
    if (!current) {
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Plan not found.');
    }
    if (current.version !== dto.version) {
      throw new AppException(
        ErrorCode.VersionConflict,
        HttpStatus.CONFLICT,
        'This plan was changed by someone else. Reload and try again.',
      );
    }
    if (current.isVisible === dto.isVisible) return toDto(current);
    if (!(await this.plans.setVisibility(id, dto.version, dto.isVisible))) {
      throw new AppException(
        ErrorCode.VersionConflict,
        HttpStatus.CONFLICT,
        'This plan was changed by someone else. Reload and try again.',
      );
    }
    return toDto({ ...current, isVisible: dto.isVisible, version: current.version + 1 });
  }

  /** A plan by id (used when assigning it to an organisation). */
  async require(id: string): Promise<PlanRecord> {
    const plan = await this.plans.findById(id);
    if (!plan) {
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Plan not found.');
    }
    return plan;
  }
}
