/**
 * The input gate's lifecycle (D25) — ONE definition shared with the card
 * states (D5): `waitingOn` is set by request_input and ends when the NEXT
 * user message reaches the thread. `/ask` embeds the pending question in
 * that turn's runtime content (buildProjectBrainstormContext), and only
 * once the engine ACCEPTS the turn flips `waitingOn` → `replyPending`;
 * `replyPending` clears when the turn settles (done, error or abort), and
 * scans resume.
 */
import type { ProjectRepository } from '../parser'
import { withProjectLock } from '../project-service'
import type { Project, ProjectWaitingOn } from '../../types'

export function createInputGate(repo: ProjectRepository) {
  async function write(projectId: string, mutate: (project: Project) => boolean): Promise<boolean> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project || !mutate(project)) return false
      repo.writeProject(project)
      return true
    })
  }

  return {
    /** request_input: a newer question supersedes the open one. */
    open(projectId: string, waiting: ProjectWaitingOn): Promise<boolean> {
      return write(projectId, project => {
        project.waitingOn = waiting
        return true
      })
    },
    /** The question's card never landed: drop the gate it opened (compare-and-set). */
    withdraw(projectId: string, questionId: string): Promise<boolean> {
      return write(projectId, project => {
        if (project.waitingOn?.questionId !== questionId) return false
        delete project.waitingOn
        return true
      })
    },
    /** After the reply turn was accepted: compare-and-set on the question id. */
    admitReply(projectId: string, questionId: string): Promise<boolean> {
      return write(projectId, project => {
        if (project.waitingOn?.questionId !== questionId) return false
        delete project.waitingOn
        project.replyPending = { questionId }
        return true
      })
    },
    /** The reply turn settled (or no turn is alive at boot). */
    settleReply(projectId: string): Promise<boolean> {
      return write(projectId, project => {
        if (!project.replyPending) return false
        delete project.replyPending
        return true
      })
    },
  }
}

export type InputGate = ReturnType<typeof createInputGate>
