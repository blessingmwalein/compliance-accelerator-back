# domain

Pure business logic with **no Nest and no Prisma imports**: scoring methodologies (`exposure_v1`,
`risk_matrix_v1`), maturity/gap/band calculation, roll-ups and metric-state rules. Everything here is
deterministic, table-tested at its boundaries, and callable from services, jobs and report generation.

Nothing lives here yet; the scoring module lands in Phase 5. See `.claude/skills/grc-domain/SKILL.md`.
