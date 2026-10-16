# ADR-0008: Reports and PDF generation

- **Status:** Accepted (report core in Phase 5, catalogue in Phase 9a)
- **Date:** 2026-10-14

## Decision
- **Server-side `pdfmake` 0.3**, one `ReportDefinition` per template, built from the same services as the API; charts as **server-rendered SVG** from the same DTOs; embedded OFL fonts.
- A report is a **stored record** with parameters, requester, methodology/framework/template versions, a JSON **data snapshot**, storage key and SHA-256, so it is reproducible and auditable. Generation is asynchronous via jobs (202 plus polling); generation and download are permission-scoped and audited.
- Rejected: **client-side jsPDF/html2canvas** (unscoped data, no audit, numbers drift from the dashboard, glyph and escaping defects) and **headless-browser PDFs** (serverless-hostile, SSRF surface; reconsider only if pixel-perfect parity becomes mandatory).

## Consequences
Hand-built SVG chart helpers are required; PDF layout is code, not CSS.

## Revisit when
A template needs rich HTML layout that pdfmake cannot express.
