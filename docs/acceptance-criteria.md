# fca-backend acceptance criteria

Derived from the master specification. Criteria are testable statements; the column **Test** names the kind of test that proves them (`unit`, `e2e` = HTTP without database, `int` = integration on the Neon `test` branch, `matrix` = generated tenancy/RBAC matrix, `golden` = metric golden test, `fe` = frontend test). The frontend repository holds the mirrored UI criteria in its own `docs/acceptance-criteria.md`. Status of each phase is tracked in [implementation-plan.md](implementation-plan.md).

## 1. Definition of Done (every feature, both repositories)
A feature is complete only when **all** of the following hold:
1. The frontend is functional (or explicitly marked *pending* in the route registry until it is).
2. The backend endpoint works and is in the OpenAPI contract (`CONTRACT_VERSION` bumped, changelog updated).
3. Data persists in PostgreSQL; migrations exist and were applied with `migrate deploy` on a clean database.
4. Validation works on the frontend (Yup) **and** the backend (DTOs); server errors map onto fields.
5. Permissions are enforced **server-side** (and reflected in the UI for UX only).
6. Tenant isolation is tested (tenancy matrix entry).
7. Loading, empty, success and failure states are handled and tested.
8. Relevant actions are audited (same transaction, fail-closed).
9. Tests pass (`npm run verify`, plus `verify:full` once integration tests exist).
10. Relevant build checks pass (`npm run build`, `openapi:check`, `api:check` in the frontend).
11. Documentation is updated (this file, implementation plan, skills if a rule changed, ADR if a decision changed).

## 2. Cross-cutting criteria
| ID | Criterion | Test |
|---|---|---|
| AC-ERR-01 | Every error is `application/problem+json` with `type`, `title`, `status`, `code`, `requestId`; `errors[]` for validation | e2e (**done**) |
| AC-ERR-02 | Unexpected errors return a generic 500 with no message, stack or secrets; the request id is logged | unit (**done**) |
| AC-ERR-03 | Unknown routes return 404 problem+json; malformed JSON returns 400 problem+json | e2e (**done**) |
| AC-ERR-04 | Unknown request properties are rejected (mass-assignment guard) | e2e (**done**) |
| AC-CON-01 | `contracts/openapi.json` equals the generated document and carries `CONTRACT_VERSION`; changelog has an entry | unit + `openapi:check` (**done**) |
| AC-CON-02 | The frontend refuses to silently run against an incompatible contract (runtime version check) | fe (**done**) |
| AC-SEC-01 | Every handler declares `@RequirePermission`, `@Public`, `@Authenticated` or `@PlatformOnly` (deny by default) | `test/access-declaration.e2e-spec.ts` (**passing**, proven to fail on a missing decorator); since 2c every access kind is accepted (`@RequirePermission`, `@OrganisationMember`, `@PlatformOnly`), exactly one per handler, and the contract carries `x-access` / `x-permission` for each (`access-declaration.e2e-spec.ts`) |
| AC-SEC-02 | Tokens: access JWT ≤ 15 min in memory; refresh token rotated, hashed, reuse revokes the family | `auth.service.spec.ts`, `access-token.service.spec.ts` (**passing**); `test/auth/auth-flow.int-spec.ts` (**passing on Neon**) |
| AC-SEC-03 | Password reset/verification/invite tokens are single-use, hashed, expiring, consumed by POST; responses do not reveal account existence | `auth.service.spec.ts` (**passing**); `auth-flow.int-spec.ts` (**passing on Neon**); invitations in 2c |
| AC-SEC-04 | Lockout and rate limits slow brute force without revealing which accounts exist | `lockout.spec.ts`, `auth.service.spec.ts`, `test/throttle.e2e-spec.ts` (**passing**); `auth-flow.int-spec.ts` (**passing on Neon**) |
| AC-SEC-05 | No secrets, tokens, cookies, connection strings or personal data in logs, emails, job payloads or error bodies | unit/int |
| AC-SEC-06 | Uploads: allow-list + magic-byte sniffing + size cap + SHA-256; downloads authorised, audited, `attachment` + `nosniff` | int (5/7) |
| AC-TEN-01 | A user of organisation B never reads, lists, updates or deletes organisation A data; foreign/unknown ids return 404 | generated tenancy matrix `test/organisations/access-matrix.int-spec.ts` and `organisations-flow.int-spec.ts` (**passing on Neon**) |
| AC-TEN-02 | Every table is tenant-scoped or listed in `GLOBAL_TABLES`; composite FKs prevent cross-tenant links | `test/database/catalogue.spec.ts` (unit, **passing**, offline); schema-level only, no tenant-to-tenant relation exists yet |
| AC-TEN-03 | RLS is on for every tenant table: queries without `app.org_id` return no rows (fail-closed), raw SQL cannot leak another tenant, a cross-tenant write is rejected | `test/database/rls.int-spec.ts` (**passing on Neon**, as the non-owner runtime role); spike S5 recorded in ADR-0004 |
| AC-RBAC-01 | Each of the six roles gets exactly the allow/deny documented in [rbac-matrix.md](rbac-matrix.md) for every endpoint | generated RBAC matrix in `access-matrix.int-spec.ts` (**passing on Neon**) plus `test/rbac-matrix-doc.spec.ts` (the reviewed document equals the catalogue), `src/permissions/catalogue.spec.ts` |
| AC-AUD-01 | Important operations write an audit event in the same transaction; failure to audit fails the operation | `src/audit/audit.service.spec.ts` (unit, passing) and `test/database/audit.int-spec.ts` (**passing on Neon**) |
| AC-AUD-02 | Audit rows cannot be updated or deleted by the application role or any API | trigger: `audit.int-spec.ts`; privilege: `runtime-role.int-spec.ts` (both **passing on Neon**, the latter as the non-owner `fca_app`) |
| AC-PERF-01 | List endpoints are paginated (cursor, `limit` ≤ 100) with allow-listed sort/filter; no unbounded queries | unit/e2e |
| AC-PERF-02 | Dashboard sections use set-based queries; no per-card fan-out; target p95 < 800 ms on realistic data | int (8) |
| AC-A11Y-01 | Frontend meets WCAG 2.2 AA on shell and every page (axe + manual keyboard review) | fe/e2e |
| AC-DATA-01 | No invented defaults: unassessed values are `NULL`/`not_assessed`; no "0 %" or "compliant" from missing data | unit/golden |
| AC-LEGAL-01 | No legal obligation text or deadline ships without provenance and `verified` status; UI/reports carry the informative-only disclaimer | int/unit |

## 3. Module criteria (Given / When / Then)
Phases refer to [implementation-plan.md](implementation-plan.md). "FE" criteria are repeated in the frontend repository.

### Authentication and accounts (2b)
| ID | Criterion | Test |
|---|---|---|
| AC-AUTH-01 | Given a new user, when they register, then an email-verification message is queued in the outbox and login is refused until verified | int |
| AC-AUTH-02 | Given an expired/used reset token, when it is submitted, then 400 `TOKEN_INVALID` (same shape as unknown token) | int |
| AC-AUTH-03 | Given a revoked session or removed member, when they call any endpoint, then 401/404 immediately | int |
| AC-AUTH-04 | The SPA restores the session on reload via refresh without storing tokens in web storage | fe |

### Organisations, memberships, User Management (2c, 3)
| ID | Criterion | Test |
|---|---|---|
| AC-USR-01 | Owner/Admin can invite by email with one of the six roles (only an Owner may invite an Owner); the invitation is single-use, expiring, revocable, one pending per address | `organisations-flow.int-spec.ts`, `invitations.service.spec.ts` (**passing**) |
| AC-USR-02 | Only the Owner can delete users (`users.delete`); Admin cannot | RBAC matrix, `organisations-flow.int-spec.ts` (**passing**) |
| AC-USR-03 | Role, status and membership changes are audited in the same transaction and take effect on the next request (a deactivated member gets 404 at once) | `organisations-flow.int-spec.ts` (**passing**) |
| AC-USR-04 | The last Owner cannot be removed or demoted, also when two Owners try at the same time | `members.service.spec.ts`, concurrency case in `organisations-flow.int-spec.ts` (**passing**) |
| AC-USR-05 | An invitation is accepted only by the signed-in account whose confirmed address was invited; a wrong, expired, revoked, replaced or used link gives one uniform error; the token is never stored, only its hash | `organisations-flow.int-spec.ts`, `invitations.service.spec.ts` (**passing**) |
| AC-ORG-01 | A signed-in user creates an organisation and becomes its Owner only when `ORGANISATIONS_SELF_SERVE` is on (`/meta` says so); otherwise a platform administrator provisions it and invites the first Owner | `organisations-flow.int-spec.ts` (**passing**) |
| AC-ORG-02 | A platform administrator sees organisation names and counts only and is not a member of what they provision (no tenant data, 404 on tenant routes); the flag is granted only with `npm run platform-admin` | `organisations-flow.int-spec.ts`, `access-matrix.int-spec.ts` (**passing**) |

### Company Settings (3)
| ID | Criterion | Test |
|---|---|---|
**Test status for Phase 3 rows (owner decision: no new automated tests in Phase 3).** "Built" means implemented and checked by throwaway integration specs (deleted afterwards), the generated access matrix and by hand on the demo company. **None of the behaviour rules below has a permanent automated test yet**; the access rules (404/403/401 on every new route) are covered by the generated matrices in `access-matrix.int-spec.ts` (**passing**) and the row-level-security spec.

| ID | Criterion | Test |
|---|---|---|
| AC-SET-01 | Company name, **country and DPO email are required** (they can be changed, not cleared; the email is validated); registration number, sector, address, DPO name and phone are optional | **built**, no permanent test |
| AC-SET-02 | Regulator contacts (authority, email, phone, notes) are stored as their own list; breach notification recipients are separate from the regulator and from the DPO, never assumed | **built**, no permanent test |
| AC-SET-03 | Applicable frameworks (CDPA, POPIA, GDPR, ISO 27701, BDPA, NIST CSF) are chosen from the catalogue; removing one keeps its history (`removed_at`), nothing is deleted | **built**, no permanent test |
| AC-SET-04 | Logo upload is private and validated: PNG/JPEG only (by bytes), ≤ 512 KiB, served to members only | **built**, no permanent test |
| AC-SET-05 | Plan visibility, assignment and entitlements are separate; hiding a plan never changes an organisation that has it; with no plan nothing is limited; the user limit counts active members plus open invitations. Billing status is **not built** (no billing integration) | **built** (except billing status), no permanent test |
| AC-SET-06 | Save shows loading/success/error; unsaved edits are detected and navigation is guarded | fe: the form kit guards; page tests are not extended in Phase 3 |
| AC-SET-07 | Organisation `timezone` (IANA) is stored; the deadline maths that uses it arrives with the first deadline (Phase 7) | validation **built**; use pending |

### Business Units (3)
| ID | Criterion | Test |
|---|---|---|
| AC-BU-01 | Name, code, description, head (an active member), sensitivity (1 to 5, or not classified), employees, status and an optional parent (active, no cycle) can be created and edited with validation; field problems come back as `errors[].path` + code | **built**, no permanent test |
| AC-BU-02 | A duplicate code in the same organisation (archived units included) is rejected with `409 BUSINESS_UNIT_CODE_TAKEN`; a duplicate name among active units with `BUSINESS_UNIT_NAME_TAKEN`; the same code in another organisation is allowed | **built**, no permanent test |
| AC-BU-03 | Units are archived, never deleted; archiving a unit with active children is refused (`409 BUSINESS_UNIT_HAS_CHILDREN`). The "linked records block it / reassign" flow waits for the first record that points at a unit (Phase 5) | archive **built**; reassign pending |
| AC-BU-04 | Search (`q`), the archived filter and cursor pagination work; the empty state explains the next step | fe **built**; page tests not extended in Phase 3 |

### Compliance Mapping (4)
| ID | Criterion | Test |
|---|---|---|
**Test status for Phase 4 rows (owner decision: no new automated tests).** "Built" means implemented and checked by two throwaway in-process smoke runs against the dev database (58 checks: access by role, validation, duplicates, archive rules, Load Default Mappings, the loader, the database triggers, row-level security as the runtime role) and a throwaway render check of the page, all deleted afterwards. **None of the behaviour rows below has a permanent automated test.**

| ID | Criterion | Test |
|---|---|---|
| AC-MAP-01 | The table shows Governance Area × one column per framework of the catalogue (never a hard-coded list) with relationship (exact/partial/related) and review status; searchable (area name), filterable (relationship, status, archived), paginated by cursor. Server-side sorting is **not built** | **built**, no permanent test |
| AC-MAP-02 | Load Default Mappings is one transaction, idempotent, never overwrites or duplicates a mapping, never brings back an archived one, is audited, and returns `inserted`/`skipped`/`failed`. `failed` is always empty today (one set-based insert; a database error rolls everything back) | **built** (smoke-checked: 1 inserted, then 0 inserted / 1 skipped, archived stays archived) |
| AC-MAP-03 | With no verified default pack the endpoint answers `422 SEED_DATA_UNAVAILABLE` and writes nothing; with no applicable framework `422 NO_FRAMEWORKS_SELECTED`; the UI explains both | **built** (smoke-checked, render-checked). **The success path is not reachable with real data**: no cited crosswalk exists, so every shipped pack has no mapping entries |
| AC-MAP-04 | Adding or editing a mapping needs two requirements of different frameworks (both in a verified version), a relationship, a rationale and a review status; reference is optional; every change and archival is audited in the same transaction; a mapping copied from the pack can only change area and review status | **built** (smoke-checked) |
| AC-MAP-05 | The Framework Reference Guide shows jurisdiction, source link, verified version, verifier and last reviewed date, requirement and default-mapping counts, "No verified content yet" for a framework with nothing loaded, and the informative-only wording | **built** (render-checked) |
| AC-FW-01 | Framework content reaches the database only through the owner-run loader, only from a pack a named person verified, whose content hash and stored source file still match; a loaded version, its requirements and its pack entries can never be changed or deleted (database triggers), and the runtime role cannot write them at all | **built** (smoke-checked: loader refuses a draft and a tampered pack; triggers block update and delete) |
| AC-FW-02 | No framework content is typed from memory: each pack records its source URL, the retrieval time and the SHA-256 of the stored source file, and says how the content was derived | **built** for NIST CSF 2.0 and the GDPR (both still DRAFT: **no verifier has signed them off**) |

### Governance Assessment (5)
| ID | Criterion | Test |
|---|---|---|
| AC-GOV-01 | Quick-start templates are versioned and verified; applying one never duplicates active records | int |
| AC-GOV-02 | Maturity (1–5), target, sensitivity/severity/likelihood are validated; gap and exposure are computed server-side from the methodology; bands configurable with reference defaults | unit/int |
| AC-GOV-03 | Unassessed items have `NULL` maturity and gap; summary metrics (average maturity, exposure, High/Critical count, average gap) exclude them and report coverage | golden |
| AC-GOV-04 | Submit → review → approve; approved assessments are immutable and history/sign-off is kept | int |
| AC-GOV-05 | Filter by business unit and framework; table and chart views; export PDF (stored report) | fe/int |
| AC-GOV-06 | Generate Remediation Tasks creates one task per gap in one transaction, skipping areas with an open task; priority from risk level; due dates by policy | int |

### Priority Matrix (5)
| ID | Criterion | Test |
|---|---|---|
| AC-EIS-01 | Quadrant is calculated from saved answers under a ruleset version; unanswered ≠ No | unit |
| AC-EIS-02 | Authorised users can change urgency/importance without hover (keyboard-accessible) with a required reason; every change is audited | int/fe |
| AC-EIS-03 | Counts per quadrant, filters (unit, framework, owner, status), item detail with rationale, risk, gap, related tasks, link to the source record | int/fe |

### Remediation Tasks (5)
| ID | Criterion | Test |
|---|---|---|
| AC-REM-01 | Assignment (user id), priority, deadline, comments, status transitions, evidence, verification, closure and reopening (with reason) | int |
| AC-REM-02 | Invalid transitions are rejected with 409 `INVALID_TRANSITION` | unit |

### Risk Register (6)
| ID | Criterion | Test |
|---|---|---|
| AC-RISK-01 | Inherent and residual risk (residual ≤ inherent), likelihood, severity, treatment, owner, review date; score and level computed server-side | unit/int |
| AC-RISK-02 | Accepting a risk records approver, rationale and expiry/review date; acceptance history is retained | int |
| AC-RISK-03 | An empty register yields `no_records`, never "zero risk" | golden |

### Data Classification, Lawful Basis, RoPA, Retention (6)
| ID | Criterion | Test |
|---|---|---|
| AC-CLS-01 | Configurable levels with handling guidance, ownership, review, links to processing activities | int |
| AC-LB-01 | Purpose, framework, lawful basis, justification, supporting evidence, review status, owner | int |
| AC-ROPA-01 | Purpose, data subjects, categories, recipients, processors, retention, international transfers, security measures, owner, business unit and review history are stored | int |
| AC-ROPA-02 | Review due/overdue uses the record's cadence and the organisation timezone; a missing review date is `not_reviewed`, not overdue; no records shows "No records yet", not "all up to date" | golden |
| AC-RET-01 | Retention rules with trigger events, exceptions, archival and disposal tracking; a legal hold prevents disposal through every path | int |

### DSAR and Breach (7)
| ID | Criterion | Test |
|---|---|---|
| AC-DSAR-01 | Request type, received date, identity verification, deadline policy, owner, status, communications, extensions (only where the policy allows), closure evidence | int |
| AC-DSAR-02 | SLA metric: completed-within-deadline vs breached vs open-not-yet-due are reported separately; denominator 0 gives `no_records` | golden |
| AC-DSAR-03 | Without a configured deadline policy the UI/API report `not_configured`; no hard-coded days | unit |
| AC-BRC-01 | Chronology (append-only), affected data, impact, investigation, containment, notification decisions (including "not required" with reason), remediation, closure | int |
| AC-BRC-02 | New breach and overdue DSAR enqueue idempotent alerts to the designated DPO contact (fallback: owners), link-only, even if the recipient is not a user | int |

### Evidence Repository and Reminders (5/7)
| ID | Criterion | Test |
|---|---|---|
| AC-EVD-01 | Private storage, metadata, owner, linked controls, review status, versions, checksum, validation, access control, audit | int |
| AC-REMD-01 | Upcoming and overdue deadlines, assignment, scheduling, preferences, delivery status; no duplicate sends per threshold; per-item failure does not abort a batch | int |

### Dashboard (8)
| ID | Criterion | Test |
|---|---|---|
| AC-DASH-01 | Each metric returns `{ availability, status, value, coverage, definitionKey, asOf }`; definitions in [metrics](metrics/README.md) | golden |
| AC-DASH-02 | Overall Maturity, Risk Exposure, DSAR SLA, Open Breaches show meaningful value, context and a link to underlying records; empty states say "Not assessed"/"No data" | golden/fe |
| AC-DASH-03 | Risk heatmap cells map to real risk records with drill-down; legend and labels; methodology named | int/fe |
| AC-DASH-04 | Framework comparison (bar/radar/table) never presents unassessed frameworks as non-compliant; includes NIST CSF where configured | golden/fe |
| AC-DASH-05 | Getting Started completion derives from saved data and persists across sessions | int/fe |
| AC-DASH-06 | AI Risk Assessment is advisory, permission-scoped, shows timestamp, sources and suggested actions, separated from calculated metrics, and fails gracefully | int/fe |
| AC-DASH-07 | Export Executive PDF generates a real PDF from authorised data with progress, success and failure feedback | int/fe |

### Reports and Audit Trail (9a)
| ID | Criterion | Test |
|---|---|---|
| AC-RPT-01 | Catalogue with date and framework filters; generation produces a stored report with versions and snapshot; history lists past reports; preview/download | int/fe |
| AC-AUD-03 | Audit Trail is searchable by actor, action, entity, date; organisation-scoped; no edit/delete for anyone | int/fe |

### Training (9b)
| ID | Criterion | Test |
|---|---|---|
| AC-TRN-01 | Courses, content, enrolments, assignments, quizzes, pass criteria, progress, due dates, certificates; auto-assignment by role and organisation frameworks | int |
| AC-TRN-02 | Quiz answers are graded **server-side**; correct answers are never sent to the client | int |
| AC-TRN-03 | Certificates are generated server-side with escaped learner/course text and a non-guessable id | int |

### Subscription and User Manual (10, 9c)
| ID | Criterion | Test |
|---|---|---|
| AC-SUB-01 | Plan catalogue, visibility, entitlements, current status and usage limits are shown; no billing integration | int/fe |
| AC-MAN-01 | Searchable help, onboarding guidance, role-specific explanations, workflow documentation | fe |
