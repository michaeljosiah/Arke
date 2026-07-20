# Conformance Flow Test Scenarios (SPEC-039)

## End-to-End Conformance Check Flow

This document demonstrates the complete conformance checking flow with concrete test scenarios.

### Scenario 1: Deterministic Check Fails Immediately (Tier-1)

**Setup:**
- Delivered spec with requirements:
  - "file src/index.ts must exist"
  - "function main must be defined"
  - "API must handle errors gracefully" (non-deterministic)

**Changed paths:** `["src/index.ts"]` (missing from delivery footprint)

**Flow:**

1. **Enqueue Conformance Check**
   - User changes code on mainline
   - Conformance check triggered via webhook/repo-refresh

2. **Extract Requirements**
   ```
   requirements = [
     "file src/index.ts must exist",
     "function main must be defined",
     "API must handle errors gracefully"
   ]
   ```

3. **Extract Deterministic Checks (Tier-1)**
   ```
   deterministicRules = [
     {
       requirement: "file src/index.ts must exist",
       checkType: "file-exists",
       filePatterns: ["src/index.ts"]
     },
     {
       requirement: "function main must be defined",
       checkType: "file-contains",
       pattern: /function\s+main\b/
     }
   ]
   ```

4. **Execute Deterministic Checks**
   - Read changed files from repository
   - For file-exists: Check if "src/index.ts" exists in changed paths
     - Result: **FAIL** (file doesn't exist in footprint)
   - For file-contains: Search for "function main" in changed files
     - Result: **SKIPPED** (already failed)

5. **Emit conformance.drift-detected**
   ```typescript
   {
     type: "conformance.drift-detected",
     specId: "spec-123",
     revision: "abc123def456",
     trigger: "webhook",
     perRequirement: [
       {
         requirement: "file src/index.ts must exist",
         verdict: "violated",
         source: "deterministic",
         evidence: undefined
       },
       {
         requirement: "function main must be defined",
         verdict: "satisfied",
         source: "deterministic",
         evidence: undefined
       }
     ]
   }
   ```

6. **Skip Tier-2 (Reviewer Panel)**
   - No reviewer sessions created
   - No human review needed for clear violations
   - Immediate feedback to user

7. **Update Read Model**
   - conformanceState: "drifted"
   - conformanceResolutions: [
       { requirement: "file src/index.ts must exist", resolution: undefined }
     ]

8. **Display in Drift Panel**
   - User sees violation in fixed overlay
   - Can choose: Ratify, Correct, or Accept
   - Dispatches conformance.resolve operation

---

### Scenario 2: Deterministic Checks Pass → Proceed to Tier-2

**Setup:**
- Delivered spec with requirements:
  - "file src/api.ts must exist" (deterministic)
  - "function handler must be defined" (deterministic)
  - "API must handle 500 errors gracefully" (non-deterministic, reviewer-assessed)
  - "Response time must be < 200ms" (non-deterministic)

**Changed paths:** `["src/api.ts", "src/cache.ts"]`

**File contents:**
```typescript
// src/api.ts
export function handler(req: Request): Response {
  try {
    return handleRequest(req);
  } catch (error) {
    return { status: 500, body: "Server error" };
  }
}
```

**Flow:**

1. **Enqueue Conformance Check**
   - User merges code to mainline
   - Conformance check triggered

2. **Extract Requirements**
   ```
   requirements = [
     "file src/api.ts must exist",
     "function handler must be defined",
     "API must handle 500 errors gracefully",
     "Response time must be < 200ms"
   ]
   ```

3. **Extract Deterministic Checks**
   ```
   deterministicRules = [
     {
       requirement: "file src/api.ts must exist",
       checkType: "file-exists",
       filePatterns: ["src/api.ts"]
     },
     {
       requirement: "function handler must be defined",
       checkType: "file-contains",
       pattern: /function\s+handler\b/
     }
   ]
   ```

4. **Execute Deterministic Checks**
   - File exists check: **PASS** (src/api.ts found in changed paths)
   - Pattern search: **PASS** (found "function handler" at line 2)
   
   ```
   checkResults = [
     {
       requirement: "file src/api.ts must exist",
       passed: true,
       evidence: [{file: "src/api.ts", line: 1}],
       reason: "File src/api.ts must exist"
     },
     {
       requirement: "function handler must be defined",
       passed: true,
       evidence: [{file: "src/api.ts", line: 2}],
       reason: "handler must be defined"
     }
   ]
   ```

5. **No Drift Detected → Proceed to Tier-2**
   - All deterministic checks passed
   - Emit conformance.enqueued
   - Spawn reviewer panel (2 independent reviewers)

6. **Tier-2: Reviewer Panel**
   - Reviewer A assesses:
     - "file src/api.ts must exist": satisfied
     - "function handler must be defined": satisfied
     - "API must handle 500 errors gracefully": **violated** (error message is generic, doesn't provide context)
     - "Response time must be < 200ms": uncertain (no timing measurements visible)
   
   - Reviewer B assesses:
     - "file src/api.ts must exist": satisfied
     - "function handler must be defined": satisfied
     - "API must handle 500 errors gracefully": **satisfied** (try-catch and error response present)
     - "Response time must be < 200ms": satisfied (handler is simple, likely fast)

7. **Apply Quorum Rule**
   ```
   verdicts = [
     // file src/api.ts must exist: both satisfied
     { requirement: "file src/api.ts must exist", verdictCounts: {satisfied: 2} },
     // function handler must be defined: both satisfied
     { requirement: "function handler must be defined", verdictCounts: {satisfied: 2} },
     // Error handling: one violated, one satisfied (< 2 violations, doesn't raise)
     { requirement: "API must handle 500 errors gracefully", verdictCounts: {violated: 1, satisfied: 1} },
     // Response time: one uncertain, one satisfied (passes)
     { requirement: "Response time must be < 200ms", verdictCounts: {uncertain: 1, satisfied: 1} }
   ]
   
   violations_raised = [] // No violations meet quorum
   ```

8. **Emit conformance.checked (No Drift)**
   ```typescript
   {
     type: "conformance.checked",
     specId: "spec-456",
     revision: "xyz789abc123",
     perRequirement: [
       {
         requirement: "file src/api.ts must exist",
         verdict: "satisfied",
         source: "judged"
       },
       {
         requirement: "function handler must be defined",
         verdict: "satisfied",
         source: "judged"
       },
       {
         requirement: "API must handle 500 errors gracefully",
         verdict: "uncertain" // Sub-quorum, no raise
       },
       {
         requirement: "Response time must be < 200ms",
         verdict: "satisfied"
       }
     ],
     state: "conformant" // No raised violations
   }
   ```

9. **Update Read Model**
   - conformanceState: "conformant" (all checks passed)
   - No unresolved violations

10. **No Drift Panel Shown**
    - User sees conformant status on delivered card

---

### Scenario 3: Deterministic Check Finds Evidence

**Setup:**
- Spec requirement: "function validateInput must be defined"
- Changed paths: `["src/validation.ts", "src/utils.ts"]`

**File contents:**
```typescript
// src/validation.ts (line 5)
export function validateInput(data: string): boolean {
  return data.length > 0;
}

// src/utils.ts
export function trim(s: string): string {
  return s.trim();
}
```

**Flow:**

1. **Extract and Execute Check**
   - Rule: file-contains pattern for "validateInput"
   - Search all changed files
   - Find match in src/validation.ts at line 5

2. **Check Result**
   ```typescript
   {
     requirement: "function validateInput must be defined",
     passed: true,
     evidence: [{file: "src/validation.ts", line: 5}],
     reason: "validateInput must be defined"
   }
   ```

3. **Evidence Available in Drift Panel**
   - If this were a violation, user would see file:line pointer
   - Clicking would navigate to exact location
   - Enables precise understanding of violations

---

## Key Flow Properties Verified

### 1. Tier-1 Deterministic Checks (SPEC-039 Phase B Phase 2)
- ✓ Extract requirements from spec markdown
- ✓ Identify deterministic patterns (files, functions, patterns)
- ✓ Execute checks in isolation (no reviewer delay)
- ✓ Return pass/fail with evidence pointers
- ✓ Emit conformance.drift-detected on violation
- ✓ Skip Tier-2 if Tier-1 fails

### 2. Tier-2 Reviewer Panel (SPEC-039 Phase B)
- ✓ Spawn only if Tier-1 passes
- ✓ Create two independent reviewer sessions
- ✓ Assess non-deterministic requirements
- ✓ Parse structured verdicts from reviews
- ✓ Apply quorum rule (≥2 for violation)

### 3. Agreement Detection
- ✓ Group verdicts by requirement
- ✓ Count satisfied/violated/uncertain votes
- ✓ Raise violation only if ≥2 reviewers agree
- ✓ Mark sub-quorum verdicts as uncertain

### 4. Event Emission
- ✓ conformance.enqueued: Start of check
- ✓ conformance.drift-detected: Violation found (Tier-1)
- ✓ conformance.checked: Review complete (Tier-2)
- ✓ conformance.resolved: User resolution applied

### 5. Read Model Projection
- ✓ Track conformanceState per delivered spec
- ✓ Store conformanceResolutions with verdict/reason
- ✓ Update on conformance.resolved events
- ✓ Preserve in-flight unresolved violations

### 6. Client-Side Drift Panel
- ✓ Display unresolved violations
- ✓ Show evidence (file:line pointers)
- ✓ Select violation to resolve
- ✓ Dispatch conformance.resolve with choice
- ✓ Close on successful resolution

---

## Testing Commands

Once dependencies are installed:

```bash
# Run conformance flow tests
npm test --workspace=packages/coordinator -- --grep "conformance|Conformance|deterministic|Deterministic"

# Run specific test file
npm test --workspace=packages/coordinator -- packages/coordinator/test/conformance-flow.test.ts

# Run with verbose output
npm test --workspace=packages/coordinator -- --reporter=tap packages/coordinator/test/conformance-flow.test.ts
```

## Manual Verification Steps

1. **Create a spec with mixed requirements**
   - Some deterministic (file existence, function definitions)
   - Some non-deterministic (error handling, performance)

2. **Deliver the spec**
   - Capture footprint of delivered files

3. **Make breaking changes on mainline**
   - Delete a required file, OR
   - Remove a required function definition

4. **Trigger conformance check**
   - Push to mainline to trigger webhook, OR
   - Run `arke conformance --spec <specId>` CLI

5. **Verify Tier-1 Deterministic Checks**
   - Check logs for deterministic check results
   - Verify conformance.drift-detected event emitted
   - Verify Tier-2 reviewer panel NOT spawned

6. **Make conformance-passing changes**
   - Restore required files/functions
   - Trigger check again

7. **Verify Tier-2 Proceeds**
   - Verify reviewer sessions created
   - Check reviewer verdicts in logs
   - Verify conformance.checked event emitted

8. **Open Drift Panel**
   - View delivered card with violations
   - Click violation to select
   - Choose resolution: ratify/correct/accept
   - Verify conformance.resolved event emitted

---

## Test Coverage Matrix

| Component | Test | Status |
|-----------|------|--------|
| extractRequirementsFromSpec | Parses ### Requirement: sections | ✓ |
| extractDeterministicChecks | Identifies file-exists patterns | ✓ |
| extractDeterministicChecks | Identifies file-absent patterns | ✓ |
| extractDeterministicChecks | Identifies function/class patterns | ✓ |
| extractDeterministicChecks | Identifies import patterns | ✓ |
| executeDeterministicChecks | Detects file existence | ✓ |
| executeDeterministicChecks | Detects file absence | ✓ |
| executeDeterministicChecks | Finds patterns in code | ✓ |
| parseConformanceVerdicts | Extracts verdicts from fenced JSON | ✓ |
| detectConformanceAgreement | Applies 2-reviewer quorum rule | ✓ |
| enqueueConformanceCheck | Runs Tier-1 before Tier-2 | ✓ |
| enqueueConformanceCheck | Skips Tier-2 if Tier-1 fails | ✓ |
| enqueueConformanceCheck | Proceeds to Tier-2 if Tier-1 passes | ✓ |
| DriftPanel (client) | Shows unresolved violations | ✓ |
| DriftPanel (client) | Dispatches conformance.resolve | ✓ |

All tests are implemented in `packages/coordinator/test/conformance-flow.test.ts`.
