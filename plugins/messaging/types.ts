// ---------------------------------------------------------------------------
// Identifier aliases — all plain strings.
//
// These used to be string-literal unions tied to one installation's roster
// (agents: basil/scout/nemo/zen; channels: general/announcements/...; content
// types: recipe/tip/motivation/...). They now exist as documented aliases
// so call sites self-describe what the string represents:
//   - ContentAgent   resolves against the runtime roster via team.* hooks
//   - ContentChannel is an opaque runtime channel id
//   - ContentType    resolves against MessagingSettings.contentTypes
// ---------------------------------------------------------------------------
import { z } from 'zod'

export type ContentAgent = string
export type ContentChannel = string
export type ContentType = string
export type ContentTone = 'energetic' | 'calm' | 'educational' | 'humorous' | 'inspiring' | 'conversational'

export type AssetRequirement = 'none' | 'optional-image' | 'image' | 'optional-video' | 'video'
export type PlanStatus =
  | 'planning'
  | 'fanning_out'
  | 'in_prep'
  | 'in_review'
  | 'scheduled'
  | 'overdue'
  | 'partially_published'
  | 'done'
  | 'cancelled'
  | 'failed'
export type DeliverableStatus =
  | 'proposed'
  | 'planned'
  | 'in_prep'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'published'
  | 'overdue'
  | 'cancelled'
  | 'failed'

// ---------------------------------------------------------------------------
// Content planning domain
// ---------------------------------------------------------------------------

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'revised'

export interface PlanProposal {
  id: string
  messageId: string
  revision: number
  agentId: string
  title: string
  targetDate: string
  brief: string
  suggestedChannels?: ContentChannel[]
  status: ProposalStatus
  planId?: string
  rejectionNote?: string
}

export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'activity'
  content: string
  timestamp: string
  proposalIds?: string[]
  kind?: string
  data?: unknown
  agentId?: string
}

export interface BrainstormSession {
  id: string
  agentId: string
  title: string
  scope?: string
  status: 'active' | 'archived'
  createdAtPlanIds: string[]
  createdAt: string
  updatedAt: string
  messages: SessionMessage[]
  proposals: PlanProposal[]
}

export interface Plan {
  id: string
  title: string
  brief: string
  targetDate: string
  agent: ContentAgent
  status: PlanStatus
  fanOutTaskId?: string
  sourceSessionId?: string
  campaign?: string
  suggestedChannels?: ContentChannel[]
  createdAt: string
  updatedAt: string
}

export interface DeliverableDraft {
  caption?: string | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  imageFilename?: string | null
  videoFilename?: string | null
  agentNotes?: string | null
}

export interface Deliverable {
  id: string
  planId: string | null
  channel: ContentChannel
  contentType: ContentType
  tone: ContentTone
  agent: ContentAgent
  title: string
  brief: string
  publishAt: string
  prepStartAt: string
  prepStartAtOverride?: string
  status: DeliverableStatus
  taskId?: string
  workflowInstanceId?: string
  pendingGateStepId?: string
  draft: DeliverableDraft
  rejectionNote?: string
  failureReason?: string
  failedAt?: string
  publishedAt?: string
  publishedDeliveryRef?: string
  createdAt: string
  updatedAt: string
}

export const DEFAULT_CHANNEL = 'general'

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

export interface ContentTypeOption {
  id: string
  label: string
  prepLeadHours?: number
  workflowId?: string
  requiresApproval?: boolean
  defaultAgent?: string
  assetRequirement?: AssetRequirement
}

export interface MessagingSettings {
  defaultView?: 'month' | 'week' | 'list'
  showScheduleJobs?: boolean
  channels?: string
  contentTypes?: ContentTypeOption[]
  sweepCronSchedule?: string
}

/**
 * Generic default content types, seeded on first activate. Intentionally
 * broad — users customize in settings. Do not ship brand-specific values here.
 */
export const DEFAULT_CONTENT_TYPES: ContentTypeOption[] = [
  { id: 'blog',         label: 'Blog post',    prepLeadHours: 72,  workflowId: 'messaging-blog-prep',       requiresApproval: true,  assetRequirement: 'optional-image' },
  { id: 'video',        label: 'Video',        prepLeadHours: 168, workflowId: 'messaging-video-prep',      requiresApproval: true,  assetRequirement: 'video' },
  { id: 'x-post',       label: 'X post',       prepLeadHours: 4,                                           requiresApproval: true,  assetRequirement: 'optional-image' },
  { id: 'image',        label: 'Image post',   prepLeadHours: 24,  workflowId: 'messaging-image-post-prep', requiresApproval: true,  assetRequirement: 'image' },
  { id: 'announcement', label: 'Announcement', prepLeadHours: 1,                                           requiresApproval: false, assetRequirement: 'none' },
]

export const ContentToneSchema = z.enum(['energetic', 'calm', 'educational', 'humorous', 'inspiring', 'conversational'])
export const ProposalStatusSchema = z.enum(['proposed', 'approved', 'rejected', 'revised'])
export const AssetRequirementSchema = z.enum(['none', 'optional-image', 'image', 'optional-video', 'video'])
export const PlanStatusSchema = z.enum(['planning', 'fanning_out', 'in_prep', 'in_review', 'scheduled', 'overdue', 'partially_published', 'done', 'cancelled', 'failed'])
export const DeliverableStatusSchema = z.enum(['proposed', 'planned', 'in_prep', 'in_review', 'changes_requested', 'approved', 'published', 'overdue', 'cancelled', 'failed'])

export const SessionMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'activity']),
  content: z.string(),
  timestamp: z.string().min(1),
  proposalIds: z.array(z.string()).optional(),
  kind: z.string().optional(),
  data: z.unknown().optional(),
  agentId: z.string().optional(),
})

export const PlanProposalSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  revision: z.number().int().positive(),
  agentId: z.string().min(1),
  title: z.string().min(1),
  targetDate: z.string().min(1),
  brief: z.string(),
  suggestedChannels: z.array(z.string()).optional(),
  status: ProposalStatusSchema,
  planId: z.string().optional(),
  rejectionNote: z.string().optional(),
})

export const BrainstormSessionSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string().min(1),
  scope: z.string().optional(),
  status: z.enum(['active', 'archived']),
  createdAtPlanIds: z.array(z.string()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  messages: z.array(SessionMessageSchema),
  proposals: z.array(PlanProposalSchema),
})

export const PlanSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  brief: z.string(),
  targetDate: z.string().min(1),
  agent: z.string().min(1),
  status: PlanStatusSchema,
  fanOutTaskId: z.string().optional(),
  sourceSessionId: z.string().optional(),
  campaign: z.string().optional(),
  suggestedChannels: z.array(z.string()).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export const DeliverableDraftSchema = z.object({
  caption: z.string().nullable().optional(),
  imagePrompt: z.string().nullable().optional(),
  videoPrompt: z.string().nullable().optional(),
  imageFilename: z.string().nullable().optional(),
  videoFilename: z.string().nullable().optional(),
  agentNotes: z.string().nullable().optional(),
})

export const DeliverableSchema = z.object({
  id: z.string().min(1),
  planId: z.string().nullable(),
  channel: z.string().min(1),
  contentType: z.string().min(1),
  tone: ContentToneSchema,
  agent: z.string().min(1),
  title: z.string().min(1),
  brief: z.string(),
  publishAt: z.string().min(1),
  prepStartAt: z.string().min(1),
  prepStartAtOverride: z.string().optional(),
  status: DeliverableStatusSchema,
  taskId: z.string().optional(),
  workflowInstanceId: z.string().optional(),
  pendingGateStepId: z.string().optional(),
  draft: DeliverableDraftSchema,
  rejectionNote: z.string().optional(),
  failureReason: z.string().optional(),
  failedAt: z.string().optional(),
  publishedAt: z.string().optional(),
  publishedDeliveryRef: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export const ContentTypeOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  prepLeadHours: z.number().nonnegative().optional(),
  workflowId: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  defaultAgent: z.string().optional(),
  assetRequirement: AssetRequirementSchema.optional(),
})

export const MessagingSettingsSchema = z.object({
  defaultView: z.enum(['month', 'week', 'list']).optional(),
  showScheduleJobs: z.boolean().optional(),
  channels: z.string().optional(),
  contentTypes: z.array(ContentTypeOptionSchema).optional(),
  sweepCronSchedule: z.string().optional(),
})
