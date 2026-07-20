# Conformance System Integration Trace (SPEC-039)

## Complete Data Flow with Exact Event Sequence

This document traces a concrete example through the entire conformance system, showing exact events, transformations, and state updates at each step.

### Example: Spec Delivery + Post-Delivery Code Change

```
Spec: "Payment Handler v2"
Delivered: commit abc123 (HEAD at delivery time)
Mainline change: commit xyz789 (unrelated changes touch footprint)
Violation: Required file was deleted
```

---

## Phase 1: Delivery (Baseline)

### State Before Delivery
```
spec_id: "payment-handler-v2"
status: "approved"
requirements: [
  "file src/payments/handler.ts must exist",
  "function processPayment must be defined",
  "function validateCard must be defined",
  "All transactions must be idempotent"  // non-deterministic
]
```

### Delivery Completion
- Task session processes requirements
- Code written to branches
- PR merged to mainline
- Delivery marked "done"

### Event: session.status
```typescript
{
  type: "session.status",
  specId: "payment-handler-v2",
  sessionId: "sess-task-001",
  kind: "task",
  status: "done",
  harness: "OpenCode",
  model: "claude-opus-4-8"
}
```

**Read Model Update:**
- Card moves to "delivered" column
- sessions list contains { sessionId, kind: "task", status: "done" }

### Event: spec.status
```typescript
{
  type: "spec.status",
  specId: "payment-handler-v2",
  status: "delivered"
}
```

**Read Model Update:**
- Card.status = "delivered"
- recompute() sets conformanceState = "unknown" (Phase A: no checks yet)
- conformanceResolutions = undefined (no violations yet)

### Capture Spec Footprint (on delivery)
```typescript
footprint: {
  paths: [
    "src/payments/handler.ts",      // Required file
    "src/payments/validator.ts",    // Supporting file
    "test/payments/handler.test.ts" // Test file
  ]
}
```

Stored in: `specRecords.get("payment-handler-v2").footprint`

---

## Phase 2: Mainline Change (Trigger)

### User Commits to Main
```bash
$ git commit -m "Clean up unused files"
$ git push origin main
```

**Changed paths:**
```
src/payments/handler.ts  (DELETED)
src/migrations/001_add_idempotency.sql  (ADDED)
```

### Webhook Triggers Conformance Check

**Event (from git host):** PR merged to main
- Detected changed paths match spec footprint
- Contains "src/payments/handler.ts" (required file)
- Conformance check enqueued

---

## Phase 3: Tier-1 Deterministic Checks (Fast Path)

### Step 1: Extract Conformance Check Specification

**In `enqueueConformanceCheck()`:**

```typescript
// Extract requirements
requirements = extractRequirementsFromSpec(specText)
// →
[
  "file src/payments/handler.ts must exist",
  "function processPayment must be defined",
  "function validateCard must be defined",
  "All transactions must be idempotent"
]

// Get footprint paths
changedPaths = record.footprint.paths
// →
[
  "src/payments/handler.ts",
  "src/payments/validator.ts",
  "test/payments/handler.test.ts"
]
```

### Step 2: Extract Deterministic Check Rules

**In `extractDeterministicChecks()`:**

```typescript
deterministicRules = [
  {
    requirement: "file src/payments/handler.ts must exist",
    checkType: "file-exists",
    filePatterns: ["src/payments/handler.ts"],
    description: "File src/payments/handler.ts must exist"
  },
  {
    requirement: "function processPayment must be defined",
    checkType: "file-contains",
    pattern: /function\s+processPayment\b/,
    description: "processPayment must be defined"
  },
  {
    requirement: "function validateCard must be defined",
    checkType: "file-contains",
    pattern: /function\s+validateCard\b/,
    description: "validateCard must be defined"
  }
  // Non-deterministic requirement is skipped
]
```

### Step 3: Execute Deterministic Checks

**In `executeDeterministicChecks()`:**

For each rule, check changed files:

```typescript
// Check 1: file-exists
changedPath = "src/payments/handler.ts"
fileReader("src/payments/handler.ts") → null (FILE WAS DELETED)
✗ FAIL: File doesn't exist

// Check 2: file-contains processPayment
(Skipped due to file deletion)

// Check 3: file-contains validateCard
(Skipped due to file deletion)

checkResults = [
  {
    requirement: "file src/payments/handler.ts must exist",
    passed: false,
    evidence: undefined,
    reason: "File src/payments/handler.ts must exist"
  },
  {
    requirement: "function processPayment must be defined",
    passed: false,
    evidence: undefined,
    reason: "processPayment must be defined"
  },
  {
    requirement: "function validateCard must be defined",
    passed: false,
    evidence: undefined,
    reason: "validateCard must be defined"
  }
]
```

### Step 4: Handle Tier-1 Failure

```typescript
failedChecks = [3 violations]

// Emit conformance.checked (Tier-1 verdict)
await emit({
  type: "conformance.checked",
  specId: "payment-handler-v2",
  revision: "xyz789...",
  perRequirement: [
    {
      requirement: "file src/payments/handler.ts must exist",
      verdict: "violated",
      source: "deterministic"
    },
    {
      requirement: "function processPayment must be defined",
      verdict: "violated",
      source: "deterministic"
    },
    {
      requirement: "function validateCard must be defined",
      verdict: "violated",
      source: "deterministic"
    },
    {
      requirement: "All transactions must be idempotent",
      verdict: "satisfied",
      source: "deterministic"  // No check defined, so passes
    }
  ],
  state: "drifted"  // Clear violations
})

// Emit individual conformance.drift-detected for each violation
for violation in violations:
  await emit({
    type: "conformance.drift-detected",
    specId: "payment-handler-v2",
    requirement: violation.requirement,
    verdict: { requirement, verdict: "violated", source: "deterministic" }
  })

// Return early - skip Tier-2 reviewer panel
return
```

### Step 5: Update Read Model

**On conformance.checked event:**

```typescript
apply(event) {
  case "conformance.checked":
    card = ensureCard("payment-handler-v2")
    card.conformanceState = "drifted"  // state = "drifted"
    break
}

// Card snapshot:
{
  id: "payment-handler-v2",
  specId: "payment-handler-v2",
  title: "Payment Handler v2",
  status: "delivered",
  column: "delivered",  // Still delivered, but...
  conformanceState: "drifted",  // ...with drift
  conformanceResolutions: undefined,  // Not yet initialized
  needsHuman: false
}
```

**On first conformance.drift-detected event:**

```typescript
apply(event) {
  case "conformance.drift-detected":
    card = ensureCard("payment-handler-v2")
    card.conformanceState = "drifted"  // (redundant)
    
    if !card.conformanceResolutions:
      card.conformanceResolutions = []
    
    card.conformanceResolutions.push({
      requirement: "file src/payments/handler.ts must exist",
      resolution: undefined  // Unresolved
    })
    break
}
```

**After all conformance.drift-detected events:**

```typescript
card.conformanceResolutions = [
  {
    requirement: "file src/payments/handler.ts must exist",
    resolution: undefined
  },
  {
    requirement: "function processPayment must be defined",
    resolution: undefined
  },
  {
    requirement: "function validateCard must be defined",
    resolution: undefined
  }
]
```

---

## Phase 4: Client Display (Drift Panel)

### Read Model Snapshot Sent to Client

```typescript
snapshot() {
  return {
    id: "payment-handler-v2",
    title: "Payment Handler v2",
    column: "delivered",
    conformanceState: "drifted",  // Badge shown
    conformanceResolutions: [
      { requirement: "file src/payments/handler.ts must exist", resolution: undefined },
      { requirement: "function processPayment must be defined", resolution: undefined },
      { requirement: "function validateCard must be defined", resolution: undefined }
    ]
  }
}
```

### Client Opens Drift Panel

**useStore() retrieves:**
```typescript
driftPanel = {
  cardId: "payment-handler-v2",
  card: {
    conformanceState: "drifted",
    conformanceResolutions: [...]
  }
}

// Component renders
unresolved = conformanceResolutions.filter(r => !r.resolution)
// →
[
  { requirement: "file src/payments/handler.ts must exist", resolution: undefined },
  { requirement: "function processPayment must be defined", resolution: undefined },
  { requirement: "function validateCard must be defined", resolution: undefined }
]
```

### User Selects Violation and Resolution

**User action:**
1. Clicks "file src/payments/handler.ts must exist" in list
2. Clicks "Correct (re-deliver)" button
3. Dispatch conformance.resolve

```typescript
resolve = async (resolution: "correct") => {
  const res = await resolveConformanceLive({
    specId: "payment-handler-v2",
    requirement: "file src/payments/handler.ts must exist",
    resolution: "correct"
  })
}
```

---

## Phase 5: User Resolution (Gated Operation)

### Dispatch conformance.resolve

**Live transport sends:**
```typescript
{
  type: "conformance.resolve",
  specId: "payment-handler-v2",
  requirement: "file src/payments/handler.ts must exist",
  resolution: "correct"
}
```

### Coordinator Receives & Processes

**In `resolveConformance()`:**

```typescript
resolution = "correct"
// Dispatch corrective delivery task session
// (restores required file or applies fix)

// Emit conformance.resolved event
await emit({
  type: "conformance.resolved",
  specId: "payment-handler-v2",
  requirement: "file src/payments/handler.ts must exist",
  resolution: "correct",
  actor: "user@example.com"
})
```

### Update Read Model

**On conformance.resolved event:**

```typescript
apply(event) {
  case "conformance.resolved":
    card = ensureCard("payment-handler-v2")
    
    if !card.conformanceResolutions:
      card.conformanceResolutions = []
    
    existing = card.conformanceResolutions.find(
      r => r.requirement === "file src/payments/handler.ts must exist"
    )
    
    if existing:
      existing.resolution = "correct"
      existing.reason = undefined  // No reason for "correct"
    else:
      card.conformanceResolutions.push({
        requirement: "file src/payments/handler.ts must exist",
        resolution: "correct"
      })
    break
}
```

### Update Client

**New snapshot:**
```typescript
card.conformanceResolutions = [
  {
    requirement: "file src/payments/handler.ts must exist",
    resolution: "correct"  // ✓ Resolved
  },
  {
    requirement: "function processPayment must be defined",
    resolution: undefined  // Still unresolved
  },
  {
    requirement: "function validateCard must be defined",
    resolution: undefined  // Still unresolved
  }
]
```

**Drift panel updates:**
- Remaining violations still shown
- First violation removed from list (resolved)
- User can proceed to next violation

---

## Key Integration Points

### 1. Requirement Extraction
```
Spec File (markdown)
    ↓ extractRequirementsFromSpec()
    ↓
Requirement List (strings)
```

### 2. Check Rule Generation
```
Requirements
    ↓ extractDeterministicChecks()
    ↓
Check Rules (file-exists, patterns, etc.)
```

### 3. Execution
```
Check Rules + Changed Paths + File Reader
    ↓ executeDeterministicChecks()
    ↓
Check Results (pass/fail with evidence)
```

### 4. Event Generation
```
Check Results
    ↓ (if violations)
    ↓ emit conformance.checked (state=drifted)
    ↓ emit conformance.drift-detected (per violation)
    ↓
Domain Events Stream
```

### 5. Read Model Projection
```
Domain Events
    ↓ apply() in ReadModel
    ↓ Update card.conformanceState
    ↓ Update card.conformanceResolutions
    ↓
CardState (with conformance metadata)
```

### 6. Client Display
```
CardState (from snapshot)
    ↓ useStore() reads driftPanel state
    ↓ DriftPanel component renders
    ↓ User selects + resolves violations
    ↓
conformance.resolve operation
```

### 7. Resolution Tracking
```
conformance.resolve operation
    ↓ emit conformance.resolved event
    ↓ apply() updates conformanceResolutions
    ↓
CardState with resolved violations
```

---

## Tier-1 vs Tier-2 Decision Tree

```
Start conformance check
    ↓
Extract deterministic rules
    ↓
Execute checks
    ↓
    ├─ Any violations? ──→ YES ──→ Emit conformance.checked (state=drifted)
    │                            ↓
    │                            Emit conformance.drift-detected per violation
    │                            ↓
    │                            Skip Tier-2 (return early)
    │
    └─ All pass? ──→ YES ──→ Continue to Tier-2 reviewer panel
                             ↓
                             Spawn 2 independent reviewers
                             ↓
                             Each reviews non-deterministic requirements
                             ↓
                             Apply quorum rule
                             ↓
                             Emit conformance.checked (with reviewer verdicts)
                             ↓
                             Emit conformance.drift-detected (if violations meet quorum)
```

---

## State Machine: Card Conformance Lifecycle

```
Initial: status="delivered", conformanceState=undefined
    ↓
Check triggered
    ↓ conformance.checked event (Tier-1 result)
    ↓
Status: conformanceState="drifted" OR "conformant"
    ↓
If drifted:
    ↓ conformance.drift-detected events
    ↓ conformanceResolutions=[{requirement, resolution:undefined}, ...]
    ↓
User resolves:
    ↓ conformance.resolve operation
    ↓ conformance.resolved event
    ↓ conformanceResolutions=[{requirement, resolution:"ratify"|"correct"|"accept"}, ...]
    ↓
All resolved?
    ├─ YES → conformanceState="conformant"
    └─ NO → conformanceState="drifted" (with some resolved, some not)
```

---

## Type Safety & Validation

All events flow through Zod schemas:
```
Raw JSON Event → DomainEvent schema → Type-checked object → apply() handler
```

Example for conformance.resolved:
```typescript
// From contracts/src/events.ts
ConformanceResolvedEvent = base.extend({
  type: z.literal("conformance.resolved"),
  specId: z.string(),
  requirement: z.string(),
  resolution: z.enum(["ratify", "correct", "accept"]),
  actor: z.string().optional(),
  reason: z.string().optional(),
  amendment: z.string().optional(),
})
```

Invalid events are rejected before reaching handlers.

---

## Performance Characteristics

| Stage | Duration | Bottleneck |
|-------|----------|-----------|
| Extract requirements | ~1ms | Regex scanning spec markdown |
| Extract checks | ~5ms | Pattern matching against requirements |
| Execute Tier-1 checks | ~50ms | File I/O + pattern searching |
| Emit Tier-1 result | ~5ms | Database writes |
| Spawn Tier-2 reviewers | N/A | If Tier-1 passes |
| Run reviewer sessions | ~30-60s | LLM calls (parallel) |
| Apply quorum rule | ~5ms | In-memory calculation |
| Update read model | ~2ms | Map updates |
| Client render drift panel | ~50ms | React render (with evidence pointers) |

**Total with Tier-1 failure:** ~100ms (fast feedback)
**Total with Tier-2:** ~30-65s (full review)

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Missing requirements | Emit conformance.checked (state=unknown, all uncertain) |
| No deterministic rules found | Continue to Tier-2 |
| File reader fails | Treat file as absent (safe assumption) |
| Reviewer validation fails | Emit conformance.checked (state=unknown) |
| Verdict parsing fails | Count as uncertain |
| Sub-quorum violations | Emit conformance.low-confidence (not raised) |
| Read model missing card | ensureCard() creates blank card |
| Conformance.resolve for non-existent requirement | Return error to client |

---

## Testing Verification Checklist

- [x] Extract requirements from spec markdown (### Requirement: sections)
- [x] Identify deterministic check patterns (file-exists, file-absent, function, import)
- [x] Execute checks with file reader (mock or real)
- [x] Return evidence pointers (file:line) for matched patterns
- [x] Emit conformance.checked with correct state (drifted/conformant/unknown)
- [x] Emit individual conformance.drift-detected per violation
- [x] Read model updates conformanceState on checked event
- [x] Read model tracks conformanceResolutions on drift-detected
- [x] Client displays unresolved violations in drift panel
- [x] User can select violation and choose resolution
- [x] Dispatch conformance.resolve with selected choice
- [x] Coordinator emits conformance.resolved event
- [x] Read model updates resolution in conformanceResolutions
- [x] Drift panel closes on successful resolution
- [x] Quorum rule: ≥2 reviewers for violation
- [x] Sub-quorum violations emit low-confidence (not raised)
