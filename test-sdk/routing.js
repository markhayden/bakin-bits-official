// Mirror of core's approvalProvenanceFromRequest (packages/core/src/approvals/provenance.ts):
// headers only; an agent-context marker overrides any declaration.
const AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function approvalProvenanceFromRequest(req, opts = {}) {
  const channel = req.headers.get('x-bakin-origin') === 'cli' ? 'cli' : 'ui'
  const agentHeader = req.headers.get('X-Bakin-Agent-Context')
  if (agentHeader !== null) {
    const id = agentHeader.trim()
    return AGENT_ID.test(id)
      ? { channel, actor: { kind: 'agent', id }, evidence: 'declared' }
      : { channel, actor: { kind: 'unknown' }, evidence: 'declared' }
  }
  const declared = req.headers.get('X-Bakin-Operator') === 'declared' || opts.formDeclaration === 'declared'
  return { channel, actor: { kind: declared ? 'operator-declared' : 'unknown' }, evidence: 'declared' }
}
