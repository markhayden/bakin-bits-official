import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { declaredCliArgShapes, execToolArgShape } from './test-helpers'

const tool = (parameters: Record<string, z.ZodType>) => ({ name: 'bakin_exec_x_y', parameters }) as never

describe('execToolArgShape', () => {
  it('derives requiredness from whether the schema accepts undefined', () => {
    expect(execToolArgShape(tool({
      plain: z.string(),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
      coerced: z.coerce.string(),
      defaulted: z.number().default(1),
    }))).toEqual({
      plain: { type: 'string', required: true },
      optional: { type: 'string', required: false },
      nullable: { type: 'string', required: true },
      coerced: { type: 'string', required: false },
      defaulted: { type: 'number', required: false },
    })
  })

  it('reports enums, string arrays and unsupported shapes as they are', () => {
    expect(execToolArgShape(tool({
      status: z.enum(['a', 'b']).optional(),
      tags: z.array(z.string()),
      piped: z.string().transform((value) => value.length),
    }))).toEqual({
      status: { type: 'string', required: false, values: ['a', 'b'] },
      tags: { type: 'string[]', required: true },
      piped: { type: 'pipe', required: true },
    })
  })
})

describe('declaredCliArgShapes', () => {
  it('returns positionals in declaration order next to the usage placeholders', () => {
    const [shape] = declaredCliArgShapes({ contributes: { cliCommands: [{
      name: 'x:toggle',
      usage: 'bakin x toggle <projectId> <itemId>',
      dispatch: { type: 'execTool', name: 'bakin_exec_x_toggle' },
      args: [
        { name: 'itemId', type: 'string', positional: true, required: true },
        { name: 'projectId', type: 'string', positional: true, required: true },
      ],
    }] } })
    expect(shape!.positionals).toEqual(['itemId', 'projectId'])
    expect(shape!.placeholders).toEqual(['projectId', 'itemId'])
  })
})
