---
name: Research Task
output_schema:
  type: object
  required:
    - findings
    - confidence
  properties:
    findings:
      type: array
      items:
        type: string
      description: The key findings, each a self-contained claim. Synthesized, not a raw link dump.
    confidence:
      type: string
      enum: [high, medium, low, speculative]
      description: Overall confidence in the findings, per the source-hierarchy calibration ladder.
    sources:
      type: array
      items:
        type: string
      description: The sources behind the findings, each noting its tier (primary / docs / practitioner / community).
    open_questions:
      type: array
      items:
        type: string
      description: What remains unverified, unreachable, or contradictory — the next best checks.
---

## Instructions

You're being asked to research one question and return structured findings. This is a workflow
step, not a free-form chat — the system expects exactly the output schema above and nothing more.

### 1. Frame the question

The dispatch message gives the question and any scope/constraints. Clarify the shape of it
internally before gathering. If the question is genuinely ambiguous enough that the answer would
change with interpretation, block and ask.

### 2. Choose the source mix and gather

Pick source types that fit the question and weight them per the `source-hierarchy` lesson. Gather
broadly before narrowing — avoid tunnel vision. For a question that decomposes into independent
sub-questions hitting different source types, apply the `parallel-lanes` lesson; otherwise stay in
one lane.

### 3. Synthesize

Force the evidence into one synthesis — not a pile of disconnected notes. Separate evidence from
speculation. Where sources disagree, surface the disagreement and say which you weight higher and
why; don't manufacture consensus. Calibrate confidence honestly (when torn, pick the lower level).

### 4. Submit step output

```
bakin_exec_submit_step taskId=<id> stepId=<step> output={"findings":[...],"confidence":"medium","sources":[...],"open_questions":[...]}
```

(Invoke Bakin tools as described in your **Tool access** section — the exact call form depends on the active runtime.)

`findings` are synthesized claims, not raw URLs. Each `sources` entry names the source AND its
tier. `open_questions` is research too — an honest "here's what isn't known" beats padded
confidence. After submitting, STOP; the workflow engine takes it from here.
