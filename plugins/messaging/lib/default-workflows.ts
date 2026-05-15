import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { PluginContext, WorkflowDefinitionInput } from '@makinbakin/sdk/types'
import yaml from 'js-yaml'
import { z } from 'zod'

export interface RegisterMessagingDefaultWorkflowsResult {
  registered: string[]
  skipped: Array<{ id: string; errors: string[] }>
}

type WorkflowStep = z.infer<typeof stepSchema>

const dependsOnSchema = z.union([z.string(), z.array(z.string())]).optional()

const stepOutputSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['string', 'file', 'number']).optional(),
  path: z.string().optional(),
})

const agentStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('agent'),
  label: z.string().min(1),
  agent: z.string().min(1),
  task: z.string().optional(),
  skill: z.string().optional(),
  description: z.string().optional(),
  outputs: z.array(stepOutputSchema).optional(),
  dependsOn: dependsOnSchema,
  deny_tools: z.array(z.string()).optional(),
})

const gateStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('gate'),
  label: z.string().min(1),
  description: z.string().optional(),
  approval_required: z.boolean().optional(),
  preview: z.array(z.string()).optional(),
  on_approve: z.string().min(1),
  on_reject: z.object({
    goto: z.string().min(1),
    note_to_agent: z.boolean().optional(),
  }).optional(),
  dependsOn: dependsOnSchema,
})

const stepSchema = z.discriminatedUnion('type', [agentStepSchema, gateStepSchema])

export const messagingWorkflowDefinitionSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number(),
  inputs: z.record(z.string(), z.object({
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })).optional(),
  steps: z.array(stepSchema).min(1),
})

function defaultWorkflowsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'defaults', 'workflows')
}

function collectStepIds(steps: WorkflowStep[]): string[] {
  return steps.map(step => step.id)
}

function topLevelStepIndex(steps: WorkflowStep[], stepId: string): number {
  return steps.findIndex(step => step.id === stepId)
}

export function validateMessagingWorkflowDefinition(definition: WorkflowDefinitionInput, id: string): string[] {
  const parsed = messagingWorkflowDefinitionSchema.safeParse(definition)
  if (!parsed.success) {
    return parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
  }

  const errors: string[] = []
  const steps = parsed.data.steps
  const ids = collectStepIds(steps)
  const idSet = new Set<string>()
  for (const stepId of ids) {
    if (idSet.has(stepId)) errors.push(`Duplicate step ID: "${stepId}"`)
    idSet.add(stepId)
  }

  for (const [index, step] of steps.entries()) {
    if (step.type === 'agent' && step.agent !== '$assigned') {
      errors.push(`Step "${step.id}": plugin-shipped messaging workflows must use "$assigned"`)
    }

    if (step.dependsOn) {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [step.dependsOn]
      for (const dep of deps) {
        if (!idSet.has(dep)) errors.push(`Step "${step.id}": dependsOn references nonexistent step "${dep}"`)
        if (topLevelStepIndex(steps, dep) >= index) errors.push(`Step "${step.id}": dependsOn "${dep}" must reference an earlier top-level step`)
      }
    }

    if (step.type !== 'gate') continue
    const expectedNext = steps[index + 1]?.id
    if (step.on_approve !== 'done' && step.on_approve !== expectedNext) {
      errors.push(
        expectedNext
          ? `Step "${step.id}": on_approve must point to the next top-level step "${expectedNext}" or "done"`
          : `Step "${step.id}": final gate on_approve must be "done"`,
      )
    }

    if (step.on_reject?.goto) {
      if (!idSet.has(step.on_reject.goto)) {
        errors.push(`Step "${step.id}": on_reject.goto references nonexistent step "${step.on_reject.goto}"`)
      } else if (topLevelStepIndex(steps, step.on_reject.goto) > index) {
        errors.push(`Step "${step.id}": on_reject.goto must rewind to this or an earlier step`)
      }
    }
  }

  if (!idSet.has('review')) errors.push(`Workflow "${id}" must include a review gate`)
  return errors
}

export function loadMessagingDefaultWorkflowDefinitions(
  workflowsDir = defaultWorkflowsDir(),
): Array<{ id: string; definition: WorkflowDefinitionInput; errors: string[] }> {
  if (!existsSync(workflowsDir)) return []

  return readdirSync(workflowsDir)
    .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort()
    .map((file) => {
      const id = file.replace(/\.(yaml|yml)$/, '')
      try {
        const raw = readFileSync(join(workflowsDir, file), 'utf-8')
        const loaded = yaml.load(raw)
        const parsed = messagingWorkflowDefinitionSchema.parse(loaded)
        const definition: WorkflowDefinitionInput = { ...parsed, id }
        return { id, definition, errors: validateMessagingWorkflowDefinition(definition, id) }
      } catch (err) {
        return { id, definition: { id, name: id, description: '', version: 1, steps: [] }, errors: [err instanceof Error ? err.message : String(err)] }
      }
    })
}

export function registerMessagingDefaultWorkflows(
  ctx: PluginContext,
  workflowsDir: string | undefined,
  log: { warn: (message: string, data?: Record<string, unknown>) => void },
): RegisterMessagingDefaultWorkflowsResult {
  const result: RegisterMessagingDefaultWorkflowsResult = { registered: [], skipped: [] }
  for (const { id, definition, errors } of loadMessagingDefaultWorkflowDefinitions(workflowsDir)) {
    if (errors.length > 0) {
      result.skipped.push({ id, errors })
      log.warn(`Skipping invalid messaging workflow "${id}"`, { errors })
      continue
    }
    ctx.registerWorkflow(definition)
    result.registered.push(id)
  }
  return result
}
