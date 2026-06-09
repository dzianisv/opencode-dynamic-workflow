/**
 * Source for the built-in `rolling-wave` workflow (Epic 3.1).
 *
 * Shipped as a string constant (built-ins live in the bundle, not on disk — see
 * {@link ./builtins}). The canonical multi-phase shape this plugin teaches:
 * decompose a goal into ordered tasks, then per task implement (verifyDiff proves
 * the agent wrote to disk) → review against the engine-computed REAL git diff
 * (contextDiff, refused on an empty diff) → fix what the review flags and
 * re-review; STOP the wave on a red gate rather than compounding onto broken
 * work; finally synthesize a report over what landed. This is the runnable
 * embodiment of the review-against-disk-truth / agentType-by-role / schema-when-
 * you-gate / stop-on-red practices the WORKFLOW_DESCRIPTION manual documents.
 *
 * The agentType triad (planner / domain-engineer / code-reviewer) is environment-
 * dependent — whichever the deployment registers activates; an unknown agentType
 * falls back to the default generalist. The optional `args.testCmd` selects the
 * verifyDiff post-condition: a command check when given, else a non-empty-diff
 * assertion.
 *
 * Authoring note: this is a JS program embedded in a TS template literal, so
 * string newlines inside it MUST be written as `\\n` (an actual newline would
 * break the embedded double-quoted literal), and the program uses `+`
 * concatenation only — no backticks or `${}` — so nothing collides with the
 * outer template.
 */
export const ROLLING_WAVE_SOURCE = `export const meta = {
  name: "rolling-wave",
  description: "Execute a multi-phase plan in rolling waves: decompose into tasks, implement each, review against the real git diff, fix what the review flags, and synthesize a final report. Stops a phase on a red gate rather than compounding onto broken work.",
  whenToUse: "When the user asks to execute a multi-phase or multi-task plan end to end with implement -> review -> fix gating.",
  phases: [
    { title: "Decompose" },
    { title: "Implement" },
    { title: "Review" },
    { title: "Fix" },
    { title: "Synthesize" },
  ],
};

// agentType names are ENVIRONMENT-DEPENDENT: the platform/registry decides them.
// These are illustrative — substitute the agentTypes your deployment registers;
// an unknown agentType falls back to the default generalist.
const PLANNER = "planner";
const IMPLEMENTER = "domain-engineer";
const REVIEWER = "code-reviewer";
const MAX_TASKS = 20;

const goal =
  args && typeof args === "object" && args.goal
    ? args.goal
    : typeof args === "string"
      ? args
      : "";
if (!goal) {
  return { error: "rolling-wave needs a goal — pass args.goal (or a string)." };
}
// Optional verification command run as a verifyDiff post-condition on implement/fix.
const testCmd =
  args && typeof args === "object" && typeof args.testCmd === "string"
    ? args.testCmd
    : "";
const verify = testCmd ? { check: testCmd } : true;

// 1. Decompose the goal into ordered, independently-implementable tasks.
phase("Decompose");
const planSchema = {
  type: "object",
  properties: { tasks: { type: "array", items: { type: "string" } } },
  required: ["tasks"],
};
const plan = await agent(
  "Decompose this goal into an ordered list of small, independently-implementable tasks. Return JSON {tasks:[...]}.\\n\\nGoal: " + goal,
  { label: "decompose", phase: "Decompose", agentType: PLANNER, schema: planSchema },
);
const tasks = (plan && plan.tasks && plan.tasks.length > 0 ? plan.tasks : [goal]).slice(
  0,
  MAX_TASKS,
);

// 2-4. For each task in order: implement (verifyDiff), review (contextDiff), fix on red.
// Sequential: a red gate STOPS before the next task rather than compounding onto
// broken work.
const GATE = {
  type: "object",
  properties: {
    gatesPass: { type: "boolean" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["gatesPass", "findings"],
};
const done = [];
for (let i = 0; i < tasks.length; i++) {
  const task = tasks[i];

  phase("Implement");
  await agent(
    "Implement this task and run the gates. Write the changes to disk.\\n\\nTask: " + task,
    { label: "implement:" + i, phase: "Implement", agentType: IMPLEMENTER, verifyDiff: verify },
  );

  phase("Review");
  let review = await agent(
    "Review the work for this task against the real git diff. Return JSON {gatesPass, findings:[...]}.\\n\\nTask: " + task,
    { label: "review:" + i, phase: "Review", agentType: REVIEWER, schema: GATE, contextDiff: true },
  );

  if (review && !review.gatesPass) {
    phase("Fix");
    await agent(
      "Address these review findings and write the fixes to disk.\\n\\nTask: " +
        task +
        "\\nFindings:\\n" +
        review.findings.join("\\n"),
      { label: "fix:" + i, phase: "Fix", agentType: IMPLEMENTER, verifyDiff: verify },
    );
    review = await agent(
      "Re-review the work for this task against the real git diff after the fix. Return JSON {gatesPass, findings:[...]}.\\n\\nTask: " + task,
      { label: "rereview:" + i, phase: "Review", agentType: REVIEWER, schema: GATE, contextDiff: true },
    );
  }

  // Stop-on-red: a null review (empty diff / agent failure) or a still-failing gate
  // halts before the next task. Sequential phases must not build on a red base.
  if (!review || !review.gatesPass) {
    log("Task " + i + " (" + task + ") did not pass review — stopping the wave.");
    break;
  }
  done.push(task);
}

// 5. Synthesize a report over what landed.
phase("Synthesize");
const report = await agent(
  "Summarize what was implemented and reviewed for this goal, and what remains. Be honest about any task that stopped the wave.\\n\\nGoal: " +
    goal +
    "\\nCompleted tasks:\\n" +
    done.map((t) => "- " + t).join("\\n"),
  { label: "synthesize", phase: "Synthesize" },
);

return {
  goal: goal,
  completed: done,
  remaining: tasks.slice(done.length),
  report: report,
};
`;
