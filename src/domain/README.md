# domain

Pure business logic with **no Nest and no Prisma imports**: scoring methodologies (`exposure_v1`,
`risk_matrix_v1`), maturity/gap/band calculation, roll-ups and metric-state rules, the register review
states, the incident deadlines and the lifecycles of a data subject request, a breach, an evidence review
and a reminder. Everything here is deterministic, table-tested at its boundaries, and callable from
services, jobs and report generation.

Two rules hold this together, because the reference app broke both by duplicating thresholds in five files:

- **One vocabulary per concept.** `incidents/deadline.ts` and `registers/review.ts` make the same four
  comparisons, and every module imports them instead of writing `<` again. `remediation/policy.ts` owns
  `todayIn` and `addDays`, so day maths happens in the organisation's calendar day or not at all.
- **A deadline is data.** Nothing here ships a statutory window. A record's dates come from the policy row
  frozen onto it (`incidents/policy.ts`), and a missing number is `not_configured` — never a guess.

See `.claude/skills/grc-domain/SKILL.md` for the normative wording.
