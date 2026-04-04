import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, parseObject, renderTemplate } from "@paperclipai/adapter-utils/server-utils";

const PLANNING_PROMPT_TEMPLATE = `You are in PLANNING MODE. You have {{maxPlanningTurns}} turns.

Your task:
{{taskTitle}}

{{taskDescription}}

## Your job right now

1. Read the task context file at skills/paperclip/references/run-context.md
2. Read relevant codebase files to understand the scope
3. Break the work into subtasks
4. For each subtask, decide: delegate to DeerFlow assistant or do yourself

Delegation rules — follow these strictly:
- Research, boilerplate, documentation, test fixtures → DELEGATE (free, runs on local GPU, zero cost)
- Complex implementation, architecture, security-sensitive code → DO YOURSELF

5. Create DeerFlow subtasks via Paperclip API for everything you're delegating.
   Your DeerFlow assistant IDs are in your instructions file — read it.
   Use the Paperclip skill's "Create subtask" endpoint with parentId set to the current task.
6. Post a plan comment on the issue listing:
   - What you delegated (with subtask links)
   - What you will implement yourself
   - Your implementation approach

## Constraints

- Do NOT write implementation code — no creating files, no editing files, no running tests
- You ARE allowed to read files to understand the codebase
- You ARE allowed to make Paperclip API calls (create subtasks, post comments, read issues)
- When done planning, exit cleanly

## Model tier guidance

You are in the planning phase — keep it efficient. Your implementation phase has a separate turn budget.
Research and boilerplate are FREE on DeerFlow. Every subtask you delegate saves paid turns in the next phase.`;

const EXECUTION_PROMPT_TEMPLATE = `You are in EXECUTION MODE. You have {{maxExecutionTurns}} turns.

Your task:
{{taskTitle}}

{{taskDescription}}

## Plan from planning phase

{{plan}}

## What was delegated to DeerFlow (do NOT redo this work)

{{delegatedSummary}}

## Your job

Implement the work items from the plan that are marked for you to do yourself.
Do NOT duplicate work that was delegated to your DeerFlow assistant — they handle those items on their own heartbeat.

Focus your turns on implementation:
- Write code, write tests, run tests
- Follow the plan's approach
- If the plan is empty or unclear, proceed with the full task using your best judgment

When done:
- Update the issue status and post a completion comment
- If you cannot finish in your remaining turns, post a progress comment listing what you completed and what remains
- Commit your work with conventional commit messages`;

export function buildPlanningPrompt(
  ctx: AdapterExecutionContext,
  maxPlanningTurns: number,
): string {
  const context = parseObject(ctx.context);
  const taskTitle = asString(context.issueTitle, asString(context.title, "Untitled task"));
  const taskDescription = asString(context.issueDescription, asString(context.description, "No description provided."));

  return renderTemplate(PLANNING_PROMPT_TEMPLATE, {
    maxPlanningTurns: String(maxPlanningTurns),
    taskTitle,
    taskDescription,
  });
}

export function buildExecutionPrompt(
  ctx: AdapterExecutionContext,
  maxExecutionTurns: number,
  plan: string,
  delegatedSummary: string,
): string {
  const context = parseObject(ctx.context);
  const taskTitle = asString(context.issueTitle, asString(context.title, "Untitled task"));
  const taskDescription = asString(context.issueDescription, asString(context.description, "No description provided."));

  return renderTemplate(EXECUTION_PROMPT_TEMPLATE, {
    maxExecutionTurns: String(maxExecutionTurns),
    taskTitle,
    taskDescription,
    plan: plan || "No structured plan was produced. Proceed with the full task.",
    delegatedSummary: delegatedSummary || "No subtasks were delegated.",
  });
}
