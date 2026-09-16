import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { PluginContext } from '@makinbakin/sdk/types'
import { terminalSettings, type Session } from './contracts'

export interface SessionOptionsData {
  agents: Array<{ id: string; name: string; enabled: boolean; workspace?: string }>
  tasks: Array<{ id: string; title: string; agentId?: string; projectId?: string }>
  defaults: { cwd: string; agentId: string }
}
function directory(value: unknown): value is string {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  try { return statSync(value).isDirectory() } catch { return false }
}
export async function sessionOptions(ctx: Pick<PluginContext, 'runtime' | 'tasks' | 'getSettings'>, recent: Session[], cwd = process.cwd()): Promise<SessionOptionsData> {
  const [roster, tasks] = await Promise.all([ctx.runtime.agents.list(), ctx.tasks.list()])
  const enabled = new Set(terminalSettings(ctx.getSettings<Record<string, unknown>>()).enabledAgents?.map((agent) => agent.id))
  const agents = roster.map((agent) => {
    const workspace = agent.metadata?.workspacePath ?? agent.metadata?.workspace
    return { id: agent.id, name: agent.name || agent.id, enabled: enabled.has(agent.id), ...(directory(workspace) ? { workspace } : {}) }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const previous = [...recent].sort((a, b) => b.createdAt - a.createdAt).find((session) => !session.worktreePath && directory(session.cwd))
  const allowed = agents.filter((agent) => agent.enabled)
  const agentId = allowed.find((agent) => agent.id === previous?.agentId)?.id ?? (allowed.length === 1 ? allowed[0].id : '')
  return {
    agents,
    tasks: tasks.filter((task) => task.column !== 'done' && task.column !== 'archived').slice(0, 200).map((task) => ({ id: task.id, title: task.title, agentId: task.agent, projectId: task.projectId })),
    defaults: { cwd: previous?.cwd ?? (directory(cwd) ? cwd : homedir()), agentId },
  }
}
