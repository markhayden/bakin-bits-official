import { useAgentList, useAgentStore } from '@makinbakin/sdk/hooks'
import type { AgentSelectOption } from '@makinbakin/sdk/patterns'
import type { SessionOptionsData } from '../lib/session-options'

export function useTerminalAgents(agents: SessionOptionsData['agents'] = []): AgentSelectOption[] {
  const registered = useAgentList()
  const display = useAgentStore((state) => state.displaySettings)
  return terminalAgentOptions(agents, registered, display)
}

export function terminalAgentOptions(
  agents: SessionOptionsData['agents'],
  registered: readonly { id: string; name: string; headshot?: string }[],
  display: Record<string, { displayName?: string; accentColor?: string }>,
): AgentSelectOption[] {
  return agents.map((agent) => {
    const identity = registered.find((item) => item.id === agent.id)
    const name = display[agent.id]?.displayName ?? identity?.name ?? agent.name
    return {
      id: agent.id,
      name: agent.enabled ? name : `${name} (access disabled)`,
      imageSrc: identity?.headshot || undefined,
      color: display[agent.id]?.accentColor,
      disabled: !agent.enabled,
    }
  })
}
