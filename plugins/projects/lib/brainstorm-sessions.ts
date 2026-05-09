/**
 * Durable brainstorm session storage for project planning conversations.
 */
import type { StorageAdapter } from '@bakin/sdk/types'
import type {
  ProjectBrainstormActivity,
  ProjectBrainstormActivityKind,
  ProjectBrainstormMessage,
  ProjectBrainstormMessageRole,
  ProjectBrainstormSession,
} from '../types'

const SESSIONS_DIR = 'projects/brainstorms'

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'default'
}

function nowIso(): string {
  return new Date().toISOString()
}

function eventId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readJson<T>(storage: StorageAdapter, path: string): T | null {
  try {
    if (storage.readJson) return storage.readJson<T>(path)
    const raw = storage.read(path)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

function writeJson(storage: StorageAdapter, path: string, value: unknown): void {
  if (storage.writeJson) storage.writeJson(path, value)
  else storage.write(path, JSON.stringify(value, null, 2))
}

function sessionPath(projectId: string, agentId: string): string {
  return `${SESSIONS_DIR}/${safeSegment(projectId)}-${safeSegment(agentId)}.json`
}

export function buildProjectBrainstormRuntimeThreadId(projectId: string, agentId: string): string {
  return `projects-${safeSegment(projectId)}-${safeSegment(agentId)}`
}

function normalizeSession(session: ProjectBrainstormSession, projectId: string, agentId: string): ProjectBrainstormSession {
  const now = nowIso()
  return {
    ...session,
    id: session.id || `${safeSegment(projectId)}-${safeSegment(agentId)}`,
    projectId,
    agentId,
    runtimeThreadId: session.runtimeThreadId || buildProjectBrainstormRuntimeThreadId(projectId, agentId),
    createdAt: session.createdAt || now,
    updatedAt: session.updatedAt || now,
    messages: Array.isArray(session.messages) ? session.messages : [],
    activities: Array.isArray(session.activities) ? session.activities : [],
  }
}

export interface ProjectBrainstormSessionStore {
  loadSession(projectId: string, agentId: string): ProjectBrainstormSession | null
  getOrCreateSession(projectId: string, agentId: string): ProjectBrainstormSession
  saveSession(session: ProjectBrainstormSession): void
  appendMessage(
    session: ProjectBrainstormSession,
    message: { role: ProjectBrainstormMessageRole; content: string },
  ): ProjectBrainstormMessage
  appendActivity(
    session: ProjectBrainstormSession,
    activity: { kind: ProjectBrainstormActivityKind; content: string; data?: unknown },
  ): ProjectBrainstormActivity
}

export function createProjectBrainstormSessionStore(storage: StorageAdapter): ProjectBrainstormSessionStore {
  function saveSession(session: ProjectBrainstormSession): void {
    const updated = { ...session, updatedAt: nowIso() }
    writeJson(storage, sessionPath(updated.projectId, updated.agentId), updated)
    Object.assign(session, updated)
  }

  function loadSession(projectId: string, agentId: string): ProjectBrainstormSession | null {
    const raw = readJson<ProjectBrainstormSession>(storage, sessionPath(projectId, agentId))
    return raw ? normalizeSession(raw, projectId, agentId) : null
  }

  function getOrCreateSession(projectId: string, agentId: string): ProjectBrainstormSession {
    const existing = loadSession(projectId, agentId)
    if (existing) return existing
    const now = nowIso()
    const session: ProjectBrainstormSession = {
      id: `${safeSegment(projectId)}-${safeSegment(agentId)}`,
      projectId,
      agentId,
      runtimeThreadId: buildProjectBrainstormRuntimeThreadId(projectId, agentId),
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
    }
    saveSession(session)
    return session
  }

  function appendMessage(
    session: ProjectBrainstormSession,
    message: { role: ProjectBrainstormMessageRole; content: string },
  ): ProjectBrainstormMessage {
    const entry: ProjectBrainstormMessage = {
      id: eventId('msg'),
      role: message.role,
      content: message.content,
      timestamp: nowIso(),
    }
    session.messages.push(entry)
    saveSession(session)
    return entry
  }

  function appendActivity(
    session: ProjectBrainstormSession,
    activity: { kind: ProjectBrainstormActivityKind; content: string; data?: unknown },
  ): ProjectBrainstormActivity {
    const entry: ProjectBrainstormActivity = {
      id: eventId('act'),
      kind: activity.kind,
      content: activity.content,
      timestamp: nowIso(),
    }
    if (activity.data !== undefined) entry.data = activity.data
    session.activities.push(entry)
    saveSession(session)
    return entry
  }

  return {
    loadSession,
    getOrCreateSession,
    saveSession,
    appendMessage,
    appendActivity,
  }
}
