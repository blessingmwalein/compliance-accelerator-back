# Metric definition sheet

Every number or state shown on the dashboard (and in reports) has a definition here **before** it is built. A metric ships with: this sheet entry, golden tests (empty, partial, full, edge), and an `availability`/`status` result that never turns missing data into a value. Rules: `.claude/skills/grc-domain/SKILL.md`. Definitions below are **drafts**; each is finalised and tested in the phase that builds its module (column *Phase*), then the dashboard (Phase 8) composes them.

## Template (copy for each metric)
| Field | Content |
|---|---|
| Key | `domain.metric` (stable; used as `definitionKey` in API responses) |
| Definition | exact formula in words and maths |
| Scope | organisation; optional filters (framework, business unit); which records and statuses count |
| Period | as-of time, window, and timezone (the organisation's) |
| Inputs | tables/columns, methodology id + version |
| Missing-data rule | what is excluded; when the result is `not_assessed`, `no_records`, `not_configured`, `unable_to_calculate` |
| Result | `{ availability, status, value, coverage, asOf }` with units |
| Access | permission required to see it |
| Tests | golden fixtures: none, partial, full, edge |

## States (shared vocabulary)
- `availability`: `ok | not_configured | not_assessed | no_records | unable_to_calculate`
- `status` (only when `ok`): `in_progress | compliant | needs_attention | overdue | null`. The UI labels `compliant` as **"Meets target"**.

## Metrics
| Key | Definition (draft) | Missing-data rule | Phase |
|---|---|---|---|
| `maturity.overall` | Mean `current_maturity` over **assessed** items of the organisation's applicable framework versions (latest submitted/approved revision per control), equal weight. Value `x / 5` (2 dp); coverage `{assessed, applicable}`. Status: `compliant` if every assessed item has current ≥ target; `needs_attention` if any assessed gap ≥ 2 (configurable); else `in_progress`. | unassessed excluded; none assessed ⇒ `not_assessed`; no frameworks ⇒ `not_configured` | 5 |
| `maturity.byFramework` | Same mean per framework version, with assessed/applicable counts and mean target. | a framework with zero assessments is `not_assessed` (never 0 %, never "non-compliant") | 5/8 |
| `gap.analysis` | Per governance area/framework: current, target, `gap = target − current` (levels). Sorted by gap desc, then exposure desc. Highlight gap ≥ threshold (default 2). | `gap = null` when either side is null | 5/8 |
| `risk.exposure.overall` | Mean `exposure_v1` score over assessed governance items; category = band of the mean under the organisation's bands; methodology id shown. The risk-register summary (`risk_matrix_v1`, residual) is a **separate** metric. | none assessed ⇒ `not_assessed`; never mixed across methodologies | 5/8 |
| `risk.heatmap` | Count of **open** (not Closed) register risks per `(likelihood, severity)` cell, residual by default with an inherent toggle; each cell drills down to its risks. | empty register ⇒ `no_records` (never "zero risk") | 6/8 |
| `risk.top` | Top N (default 10) by exposure desc under the stated methodology; tie-breakers: severity desc, earlier next-action date, name. Includes owner, business unit/framework, related task, next action. | no items ⇒ `no_records` | 6/8 |
| `priority.quadrants` | Counts of governance areas/tasks per quadrant (Do Now, Plan, Delegate, Eliminate) from saved answers under a ruleset version; items without a completed questionnaire are reported as `unclassified`, not hidden. | unanswered ≠ No | 5/8 |
| `ropa.monitor` | Processing activities by business unit; review state per record = `ok`, `due_soon` (within the record's lead window), `overdue` (past cadence), `not_reviewed` (no date); lists of upcoming and overdue reviews. | zero activities ⇒ `no_records` ("No records yet", never "all up to date"); missing review date ⇒ `not_reviewed` | 6/8 |
| `dsar.sla` | Over requests received in the window (default last 12 months): `withinSla` = completed on/before deadline; `breached` = completed late + open past deadline; `openNotYetDue` is reported **separately** and excluded from the percentage. Percentage = `withinSla / (withinSla + breached)`. Status `overdue` if any open request is past its deadline. | no deadline policy ⇒ `not_configured`; denominator 0 ⇒ `no_records` | 7 |
| `breaches.open` | Count of breaches not Closed; `annualTotal` = breaches detected in the current calendar year (organisation timezone). Status `overdue` when a configured notification deadline has passed without a recorded decision. | none ⇒ `no_records` | 7 |
| `frameworks.coverage` | Per applicable framework: assessed vs applicable controls, outstanding findings (open remediation tasks), distribution of gap bands. | coverage 0 ⇒ `not_assessed`; **never** labelled "Non-compliant" | 5/8 |
| `onboarding.progress` | Six steps derived from saved data: (1) company details saved incl. country and DPO email; (2) ≥ 1 business unit; (3) ≥ 1 submitted assessment; (4) ≥ 1 RoPA record; (5) ≥ 1 classified record (levels configured); (6) frameworks configured and ≥ 1 mapping reviewed. Progress = completed / 6. Dismissing hides the panel but never marks steps complete. | derived, never stored as a flag | 3–8 |

## Golden-test fixtures (each metric)
`empty` (no records, nothing configured) · `configured-but-empty` · `partial` (some assessed) · `full` · `edge` (all overdue, nothing due yet, boundary dates around midnight in the organisation timezone, single record). Expected `availability/status/value/coverage` live next to the test.
