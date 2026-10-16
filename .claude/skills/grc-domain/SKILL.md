---
name: grc-domain
description: Use when implementing or changing anything about assessments, maturity, gap, risk scoring and bands, heatmaps, the Eisenhower priority rule, status lifecycles, deadlines/SLAs, dashboard metrics or their data states (not assessed, no records, overdue…) in fca-backend. Normative domain rules for FCA.
---

# GRC domain (backend, normative)

## When to use
Whenever a number, band, status, deadline or "compliance" label is computed or stored. The reference app mixed three score scales, defaulted missing data to "worst case" or "compliant", and duplicated thresholds in five files: this skill exists to prevent that. Pure logic goes in `src/domain/` (no Nest, no Prisma). Frontend consumer rules live in `fca-frontend/.claude/skills/grc-domain`.

## Rules

### 1. Never conflate three different things
**Maturity** (how well a control is implemented, 1–5), **risk exposure** (how bad it is if it fails) and **compliance status** (whether a legal requirement is met) are different. Software computes maturity and risk from user-entered inputs; it **never** asserts legal compliance. UI copy says "Meets target maturity", not "Compliant" (see disclaimer below).

### 2. Named methodologies (versioned; never inline thresholds)
All thresholds live in a `Methodology` value (`src/domain/scoring/methodologies.ts`, Phase 5) with an id and version. Stored results record `methodology_id`, `methodology_version` and a **band snapshot**; approved records are immutable (a re-score is a new revision). Organisations may override bands (contiguous, covering the full range, ≥ 3 bands) over a global default; a band change triggers an audited recalculation job, never silent rewrites.

| id | formula | range | reference default bands |
|---|---|---|---|
| `exposure_v1` (governance area / assessment item) | sensitivity × severity × likelihood, each 1–5 | 1–125 | Low ≤ 25, Medium 26–60, High 61–90, Critical ≥ 91 |
| `risk_matrix_v1` (risk register, heatmap) | likelihood × severity, each 1–5 | 1–25 | Low 1–5, Medium 6–11, High 12–19, Critical ≥ 20 |
| `maturity_v1` | current and target 1–5; `gap = target − current` (levels, 0–4, never a percentage) | 1–5 | 1 Initial, 2 Managed, 3 Defined, 4 Quantitatively Managed, 5 Optimizing |

Scale labels (reference defaults): sensitivity Public/Internal/Confidential/Restricted/Critical; severity (a.k.a. impact) Minimal/Minor/Moderate/Major/Catastrophic; likelihood Rare/Unlikely/Possible/Likely/Almost Certain. Use **"severity"** in the API for impact. Residual risk uses the same matrix with residual likelihood/severity and must be ≤ inherent.

**Methodology facts the owner should know** (verified by enumeration): attainable `exposure_v1` values are `1,2,3,4,5,6,8,9,10,12,15,16,18,20,24,25,27,30,32,36,40,45,48,50,60,64,75,80,100,125`, so nothing exists between 81 and 99; with the reference bands only 4 of 125 input combinations are **Critical** (100 or 125), 7 are **High** (64, 75, 80), 34 Medium, 80 Low. `risk_matrix_v1` splits 25 combinations into Low 10, Medium 7, High 5, Critical 3. The band editor must show attainable values, and the owner should confirm these defaults before Phase 5 ships.

The three scales are **not interchangeable**: label every chart/metric with its methodology, and default the heatmap to `risk_matrix_v1` on **residual** risk with an *inherent* toggle.

### 3. Missing data (MUST)
- Unassessed maturity/target/likelihood… is `NULL`. **No defaults** (the reference defaulted maturity to 2, target to 5, ratings to 3, and treated a missing date as "overdue" and a missing score as "Critical"/"Non-Compliant").
- Calculations return `null` + a reason, not 0: `gap = null` when either side is null.
- Aggregates drop nulls and return **coverage** `{ assessed, applicable }` alongside the value. A framework with zero assessments is `not_assessed`, never "0 %" or "Non-compliant". An empty risk register is `no_records`, never "zero risk". Missing evidence is never proof of compliance.

### 4. Metric state vocabulary (shared with the frontend through the contract)
Two orthogonal axes (the spec's eight states mix them):
- `availability`: `ok | not_configured | not_assessed | no_records | unable_to_calculate`
- `status` (only when `availability = ok`): `in_progress | compliant | needs_attention | overdue | null`
Every dashboard section is `{ availability, status, value, coverage, definitionKey, asOf, error? }`. One failing section never blanks the page. Each metric has a definition sheet in `docs/metrics/` (definition, scope, period, missing-data rule, test).

Key definitions (full sheet built in Phase 8; modules ship theirs from Phase 5):
- **Overall maturity** = mean of `current_maturity` over *assessed* items of applicable frameworks in submitted/approved assessments; value `x / 5`, coverage `assessed/applicable`; `not_assessed` if none.
- **DSAR SLA** = of requests whose deadline has passed *or* that are completed: `withinSla = completed on/before deadline`, `breached = completed late + open and past deadline`; `openNotYetDue` is reported **separately** and excluded from the percentage. Denominator 0 ⇒ `no_records`.
- **Open breaches** = breaches not Closed (annual total reported separately). Counts, not percentages.
- **Risk exposure** (dashboard) = per its stated methodology; show category + methodology label; never mixed across `exposure_v1` and `risk_matrix_v1`.

### 5. Prioritisation: Eisenhower rule v1
Five urgency questions (`manual_handling`, `no_controls`, `regulator_deadline` (≤ 90 days), `active_breach`, `third_party_access`) and five importance questions (`sensitive_data`, `high_volume` (> 500 data subjects), `cross_border`, `core_business`, `regulatory_obligation`). Default rule: **urgent = any urgency answer is Yes; important = any importance answer is Yes** (configurable per organisation later). Quadrants: Do Now (U∧I), Delegate (U∧¬I), Plan (¬U∧I; default scheduling 30–90 days, configurable), Eliminate (¬U∧¬I). Persist the **answers** and `ruleset_version` (the reference lost them), plus the derived `urgent`/`important`/`quadrant`; **unanswered ≠ No** (an incomplete questionnaire yields no quadrant, status `not_assessed`). Changing flags manually is allowed for authorised users, requires a reason, and is audited. Suggested owners are *role hints* (e.g. DPO / Compliance Manager), never "Intern".

### 6. Lifecycles (proposed; finalised with the owner when each module is built)
- **Assessment**: Draft → In Review → Approved (immutable) → Superseded; sign-off records approver, time, comment.
- **RoPA**: Draft → Under Review → Approved → Needs Update (→ Under Review). Review cadence is **per record** (`review_every_days`, default 180; "due soon" window default 30 days before due: the reference's fixed 150/180 become defaults). Missing last-review date ⇒ `not_reviewed`, not "overdue".
- **Risk**: Open → In Treatment → Accepted | Transferred → Closed. *Accepted* requires approver, rationale and a review/expiry date; acceptance history is kept.
- **Remediation task**: Open → In Progress → Blocked? → Completed → Verified; Cancelled; reopen with reason. Due date default by priority 14/30/60/90 days (Critical/High/Medium/Low), configurable. Assignee is a user id.
- **DSAR**: Received → Identity Verification → In Progress → (Extended, only where the policy allows, with reason) → Completed | Rejected; closure evidence required.
- **Breach**: Detected → Investigating → Contained → (regulator/data-subject notification *decisions* recorded, including "not required" with reason) → Remediating → Closed; chronology is append-only.
- **Retention**: schedule rules with trigger events; a **legal hold** (organisation | record type | record) blocks disposal everywhere through one `assertDisposable()`.

### 7. Deadlines are data, not code
DSAR response windows, breach-notification windows and extensions are **deadline policies** stored per organisation/framework with `source`, `verified_by`, `verified_at`; default **Not configured** (no hard-coded "30 days", "72 hours" or "24 hours": several legacy claims are unverified: see `compliance-frameworks`). Reminders, SLA metrics and overdue states read the policy; without one they report `not_configured`.

### 8. Disclaimer (appears in the API description, reports and UI help)
FCA supports a privacy/compliance programme. Assessments, scores, mappings, AI suggestions and reports are informative aids; they do not constitute legal advice or guarantee compliance with any law. Cross-framework mappings do not establish legal equivalence.

## Example

```ts
// src/domain/scoring/exposure.ts  (pure, table-tested)
export interface ExposureInput { sensitivity: number | null; severity: number | null; likelihood: number | null }
export type Scored<T> = { state: 'scored'; value: T } | { state: 'not_assessed'; missing: readonly string[] };

export function exposure(input: ExposureInput): Scored<number> {
  const missing = (['sensitivity', 'severity', 'likelihood'] as const).filter((k) => input[k] === null);
  if (missing.length > 0) return { state: 'not_assessed', missing };
  return { state: 'scored', value: input.sensitivity! * input.severity! * input.likelihood! };
}

export function bandFor(score: number, bands: readonly Band[]): Band {        // bands come from the methodology snapshot
  return bands.find((b) => score >= b.min && score <= b.max) ?? failUnreachable(score);
}
```

## Anti-patterns

Seen in the legacy app; do not repeat:

`current_maturity` defaulted to 2 and `target` forced to 5; `gap` computed as `(target||5) − (current||0)`; exposure/level persisted and stale; heatmap bands (≤6/12/20) differing from the register (≥6/12/20) and ignoring sensitivity; a gauge using `score/125` with different cut-offs; "compliance %" that is really a maturity index (level 1 = 20 %); framework scores by substring-matching names; `Intern/Junior Analyst` as an Eliminate owner; `urgent/important` overwritten without updating the quadrant; unanswered questions treated as No; RoPA "overdue" when a date is missing; Critical shown when the score is undefined.

## Checklist
- [ ] Logic is a pure function in `src/domain/`, takes the methodology/bands and an injected clock
- [ ] Inputs nullable, no defaults; result is `not_assessed`/`null`, aggregates return coverage
- [ ] Table tests at band boundaries (25/26, 60/61, 90/91; 5/6, 11/12, 19/20) and with empty/partial data
- [ ] Stored snapshot carries methodology id + version + bands; approved rows immutable
- [ ] Metric has a definition sheet entry and a golden test; availability/status set correctly
- [ ] Deadlines read a policy; `not_configured` handled; disclaimer present where results are shown

## References
`src/domain/README.md`, `docs/metrics/README.md`, `docs/reference/legacy-findings.md`, `compliance-frameworks`, `testing-and-quality`.
