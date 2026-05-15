export interface DistributionChannelDefinition {
  id: string
  label: string
  contentType: string
}

export const MESSAGING_DISTRIBUTION_CHANNELS: DistributionChannelDefinition[] = [
  { id: 'blog', label: 'Blog', contentType: 'blog' },
  { id: 'x', label: 'X', contentType: 'x-post' },
  { id: 'instagram', label: 'Instagram', contentType: 'image' },
  { id: 'tiktok', label: 'TikTok', contentType: 'video' },
  { id: 'meta', label: 'Meta', contentType: 'image' },
  { id: 'discord', label: 'Discord', contentType: 'announcement' },
  { id: 'slack', label: 'Slack', contentType: 'announcement' },
  { id: 'reddit', label: 'Reddit', contentType: 'announcement' },
  { id: 'custom', label: 'Custom', contentType: 'announcement' },
]

export function getDistributionChannelDefinition(channelId: string): DistributionChannelDefinition {
  return MESSAGING_DISTRIBUTION_CHANNELS.find((channel) => channel.id === channelId)
    ?? { id: channelId, label: channelId, contentType: 'announcement' }
}
