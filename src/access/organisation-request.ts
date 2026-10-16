import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { MembershipSummary } from './membership-lookup.repository.js';

/** A request that passed the access guard for an organisation route: the caller's verified membership is attached. */
export interface OrganisationRequest extends AuthenticatedRequest {
  membership: MembershipSummary;
}
