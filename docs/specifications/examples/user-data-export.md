<!--
  Reference example of a completed Arke specification (NOT a real Arke feature).
  Kept here to show the canonical format end-to-end. New specs follow this shape;
  see ../specification.template.md for the blank template and the lifecycle rules.
-->

---
spec_id: SPEC-2026-06-27-user-data-export
title: User-initiated data export
status: in-review            # draft -> in-review -> approved
branch: feat/user-data-export
owner: <product engineer>
capabilities: [data-export, account-settings]
created: 2026-06-27
updated: 2026-06-27
---

# User-initiated data export

## Why
Users have no way to get their own data out of the product, which blocks portability requests and creates manual support work. This adds a self-service export.

## What changes
- ADDED data-export — a user can request and download an export of their personal data
- MODIFIED account-settings — the settings screen gains an "Export my data" action   (breaking: no)

---

## Requirements

### Requirement: Request a data export
`capability: data-export` · `delta: ADDED (feat/user-data-export)`

The system SHALL let an authenticated user request an export of their own personal data, and SHALL scope every export to the requesting user only.

#### Scenario: User requests an export
- **WHEN** an authenticated user triggers "Export my data"
- **THEN** the system creates an export job for that user
- **AND** responds that the export is being prepared

#### Scenario: Export is scoped to the requester
- **WHEN** an export job runs for user A
- **THEN** the output contains only user A's data
- **AND** no record belonging to another user is included

### Requirement: Deliver the export asynchronously
`capability: data-export` · `delta: ADDED (feat/user-data-export)`

The system SHALL process exports asynchronously and SHALL notify the user when the export is ready to download.

#### Scenario: Large export does not block the request
- **WHEN** a user requests an export that takes more than a few seconds to build
- **THEN** the request returns immediately with a pending status
- **AND** the export continues in the background

#### Scenario: User is notified when ready
- **WHEN** an export job completes
- **THEN** the user is notified that the download is available

### Requirement: Protect the download
`capability: data-export` · `delta: ADDED (feat/user-data-export)`

The system SHALL make a completed export available only to the user who requested it, through a link that expires.

#### Scenario: Expired link is rejected
- **WHEN** a user opens an export download link after it has expired
- **THEN** the system refuses the download
- **AND** offers to generate a fresh export

### Requirement: Settings actions
`capability: account-settings` · `delta: MODIFIED (feat/user-data-export)`

The system SHALL present, on the account settings screen, the actions a user can take on their account, and SHALL include an "Export my data" action among them.

#### Scenario: Export action is visible in settings
- **WHEN** a user opens account settings
- **THEN** an "Export my data" action is shown alongside the existing account actions

---

## Design

### Architectural decision
Run exports as background jobs that write a file to object storage and hand back a short-lived signed URL, rather than streaming inline, so large exports never block a request and the download stays access-controlled.

### Target architecture
A small export service accepts a request, enqueues a job, and records its status. A worker builds the file, writes it to object storage, and marks the job ready. The client polls or is pushed the status, then fetches a signed URL.

### Data model
`export_job { id, user_id, status (pending|ready|expired|failed), file_ref, created_at, expires_at }`.

### Interfaces and contracts
- `POST /exports` — create a job for the current user; returns `{ id, status: "pending" }`.
- `GET /exports/:id` — job status; when ready, includes a signed, expiring download URL.

### Cross-cutting
- Security: authorise every call to the owning user; sign download URLs; expire them.
- Performance: asynchronous by default; cap concurrent jobs per user.

---

## Tasks
- [ ] export_job model and migration
- [ ] POST /exports and GET /exports/:id
- [ ] background worker that builds the CSV and writes to storage
- [ ] signed, expiring download URLs
- [ ] "Export my data" action in account settings
- [ ] notification on completion

### Testing
- Unit: scoping (user A never sees user B), expiry rejection.
- Integration: request to ready to download happy path; large-export async path.
- Manual: trigger from settings, receive notification, download once, confirm expiry.

### Definition of done
All scenarios above pass, checks are green, and a reviewer has signed off on the release.

---

## Decision log
| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Asynchronous jobs with signed, expiring URLs | Large exports must not block requests; downloads must stay access-controlled |
| 2 | CSV for v1 | Simplest portable format; other formats can be added behind the same job model |

## Open questions
- Retention: how long should a built export file live before expiry?

## Change history
- 2026-06-27 · feat/user-data-export · in-review — ADDED data-export (request, async delivery, protected download); MODIFIED account-settings (export action)
