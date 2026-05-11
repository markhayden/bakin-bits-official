import type { ContentTypeOption, MessagingSettings } from '../types'
import { DEFAULT_CONTENT_TYPES } from '../types'

export function contentTypeFor(settings: MessagingSettings, contentTypeId: string): ContentTypeOption {
  return (settings.contentTypes ?? DEFAULT_CONTENT_TYPES).find(type => type.id === contentTypeId)
    ?? { id: contentTypeId, label: contentTypeId, assetRequirement: 'none', prepLeadHours: 0 }
}
