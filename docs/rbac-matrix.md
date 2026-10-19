# RBAC matrix (v1: implemented in the catalogue; **owner review still open**)

The owner chose the legacy code's **six roles**. The legacy matrix (`PermissionGuard.jsx`) was coarse (`governance.*`, `data.*`, `reports.*`, `training.*`, `users.*`, `company.*`), so this document keeps its semantics, expresses them per permission, and marks every **addition** needed for the modules the specification lists.

The matrix is implemented in [`src/permissions/catalogue.ts`](../src/permissions/catalogue.ts) (Phase 2c). A unit test parses the tables below and **fails if they differ from the catalogue** in either direction, so this file cannot drift. The catalogue also drives the OpenAPI `x-permission` extension, the `GET /organisations/:organisationId/me` response and the generated RBAC test matrix. Only the keys used by built endpoints are enforced today (`users.*` in 2c); the rest take effect as their modules are built.

Roles: **OWN** Company Owner · **ADM** Company Admin · **CMG** Compliance Manager · **CRS** Course Administrator · **STD** Standard User · **RO** Read Only.
The **DPO** is a designated contact on the organisation, not a role. The **platform admin** flag sits outside these roles (section 3, ADR-0005).

## 1. Permissions inherited from the legacy matrix
| Permission | OWN | ADM | CMG | CRS | STD | RO | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `governance.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | assessments, priority, remediation, risk |
| `governance.create` | ✓ | ✓ | ✓ | – | – | – | |
| `governance.edit` | ✓ | ✓ | ✓ | – | – | – | |
| `governance.delete` | ✓ | ✓ | – | – | – | – | |
| `data.create` | ✓ | ✓ | ✓ | – | ✓ | – | classification, lawful basis, RoPA, retention, DSAR, breaches, evidence |
| `data.edit` | ✓ | ✓ | ✓ | – | ✓ | – | |
| `data.delete` | ✓ | ✓ | ✓ | – | – | – | |
| `data.export` | ✓ | ✓ | ✓ | – | – | – | |
| `training.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `training.create` | ✓ | ✓ | – | ✓ | – | – | |
| `training.edit` | ✓ | ✓ | – | ✓ | – | – | |
| `training.delete` | ✓ | ✓ | – | ✓ | – | – | |
| `training.assign` | ✓ | ✓ | – | ✓ | – | – | |
| `users.view` | ✓ | ✓ | – | – | – | – | members and invitations (list) |
| `users.create` | ✓ | ✓ | – | – | – | – | invite, resend, revoke |
| `users.edit` | ✓ | ✓ | – | – | – | – | change a member's role (granting or removing Owner needs an Owner) |
| `users.delete` | ✓ | – | – | – | – | – | deactivate and reactivate a member |
| `company.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | |
| `company.edit` | ✓ | ✓ | – | – | – | – | settings, frameworks, DPO and regulator contacts |
| `company.branding` | ✓ | – | – | – | – | – | logo, display name |
| `reports.view` | ✓ | ✓ | ✓ | – | – | ✓ | |
| `reports.export` | ✓ | ✓ | ✓ | – | – | – | |

## 2. Additions (new permission keys; please review)
| Permission | OWN | ADM | CMG | CRS | STD | RO | Why |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `dashboard.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | the legacy gave no explicit key; CRS lands on Training |
| `data.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | the legacy had no view key for registers; Read Only could not otherwise read them |
| `businessUnits.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | new module |
| `businessUnits.create` | ✓ | ✓ | – | – | – | – | organisation structure is an admin concern |
| `businessUnits.edit` | ✓ | ✓ | – | – | – | – | |
| `businessUnits.delete` | ✓ | ✓ | – | – | – | – | |
| `mapping.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | Compliance Mapping |
| `mapping.edit` | ✓ | ✓ | ✓ | – | – | – | mappings are advisory but consequential |
| `mapping.loadDefaults` | ✓ | ✓ | ✓ | – | – | – | |
| `governance.approve` | ✓ | ✓ | ✓ | – | – | – | assessment sign-off, risk acceptance, DSAR/breach closure approval (spec: review and approval workflow) |
| `remediation.updateOwn` | ✓ | ✓ | ✓ | – | ✓ | – | status/comments on tasks assigned to the caller (record-level rule); otherwise STD cannot progress their own tasks |
| `audit.view` | ✓ | ✓ | ✓ | – | – | – | the legacy showed Audit Trail to every role (a defect) |
| `audit.export` | ✓ | ✓ | ✓ | – | – | – | a CSV copy of the trail leaves the product, so reading it and taking it away are separate keys |
| `reminders.view` | ✓ | ✓ | ✓ | – | ✓ | ✓ | own and organisation reminders |
| `reminders.manage` | ✓ | ✓ | ✓ | – | – | – | assign, schedule |
| `notifications.own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | in-app notifications and preferences: everyone |
| `subscription.view` | ✓ | ✓ | – | – | – | – | plan, entitlements, usage |
| `subscription.manage` | ✓ | – | – | – | – | – | commercial decisions |
| `ai.run` | ✓ | ✓ | ✓ | – | – | – | AI risk assessment; also entitlement-gated and per-organisation opt-in |
| `training.take` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | My Training: everyone completes assigned training |

## 3. Platform scope (outside the six roles; assumption, ADR-0005)
`platform.organisations.manage` (provision organisations) and `platform.plans.manage` (plan catalogue and visibility). Held by the `users.is_platform_admin` flag, which is set only with `npm run platform-admin -- grant <email>` using the owner database credentials (never through the API). Only `/api/v1/platform/*`; a platform admin has **no** access to any organisation's data unless they are also a member of it.

## 4. Rules beside the permission check
- **Owner role:** only a Company Owner may grant the Owner role (invitation or role change), change an Owner's role or deactivate an Owner. A Company Admin cannot.
- **Last owner (AC-USR-04):** an organisation always keeps at least one active Owner; demoting or deactivating the last one fails with `LAST_OWNER` (409), also under concurrent requests.
- **Own membership:** nobody can change their own role or deactivate themselves (`SELF_CHANGE_NOT_ALLOWED`); another Owner must do it.
- **Not a member, or deactivated:** 404 for every organisation route (existence is not confirmed). **A member without the permission:** 403, decided before any record is looked up.

## 5. Review items for the owner
1. **Standard User** can create/edit data registers including **DSAR and Breach** (legacy `data.*`). Consider restricting DSAR/Breach to CMG and above.
2. **Compliance Manager** cannot view `users`, `subscription`, or edit company settings (legacy). Confirm.
3. **Course Administrator** sees only Training (+ own notifications). Confirm that no dashboard is intended.
4. **Read Only** can view reports (legacy) but not export.
5. **Company Admin cannot deactivate a member** (legacy `users.delete` is Owner-only) but can invite, change roles below Owner and revoke invitations. Confirm, or give Admin `users.delete` for non-Owner members.
6. The manual's **Auditor** (read-only incl. audit trail) and **Assessor** (own business units only) have no equivalent in this model. An Auditor-style role can be added later without schema change.
