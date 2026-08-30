import { fetchSlackThreadReplies } from '@chat-adapter/slack/api'
import { renderSlackDisplayText } from './slack-display-text'
import type { JsonObject, SlackbotV2ApiMessage, SlackbotV2Options } from './types'
import type { EvalUsageAttempt } from './eval-usage'
import { stringValue } from './utils'

export type SlackInteractionSinkMessage = {
  provider_message_id: string
  sender: {
    provider_user_id: string
    display_name: string
    user_kind: 'human' | 'agent'
    avatar_url?: string
    avatar_asset?: {
      sha256: string
      filename: string
      provenance: JsonObject
    }
    profile_refreshed_at?: string
  }
  content: string
  source_created_at: string
}

export type SlackInteractionSinkEnvelope = {
  workspace_id: string
  channel_id: string
  thread_id: string
  surface_kind: 'channel' | 'dm'
  messages: SlackInteractionSinkMessage[]
  interaction_finished: boolean
  agent_usage?: EvalUsageAttempt[]
}

export type SlackInteractionSnapshotResult = {
  chatObjectId?: string
  outcome: 'disabled' | 'skipped' | 'sent'
}

type SlackProfile = {
  displayName?: string
  avatarUrl?: string
  refreshedAt: string
}

type CachedSlackProfile = {
  profile: SlackProfile
  expiresAt: number
}

const profileCaches = new WeakMap<SlackbotV2Options, Map<string, CachedSlackProfile>>()
const MAX_PROFILE_LOOKUPS_PER_SNAPSHOT = 500

export function isExplicitInteractionFinish(text: string): boolean {
  const mentionless = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, '')
    .replace(/^@[UW][A-Z0-9]+\s+/i, '')
    .trim()
  return /^(?:finished|done)[.!]?$/i.test(mentionless)
}

export function buildSlackInteractionEnvelope(input: {
  botUserId?: string
  currentMessage: SlackbotV2ApiMessage
  replies: readonly JsonObject[]
  userName?: string
}): SlackInteractionSinkEnvelope | null {
  const rawCurrent = asRecord(input.currentMessage.raw)
  const channelId = stringValue(rawCurrent.channel) ?? threadPart(input.currentMessage.threadId, 1)
  const threadId =
    stringValue(rawCurrent.thread_ts) ??
    stringValue(rawCurrent.ts) ??
    threadPart(input.currentMessage.threadId, 2)
  const workspaceId =
    input.currentMessage.teamId ??
    stringValue(rawCurrent.team) ??
    stringValue(rawCurrent.team_id)
  if (!workspaceId || !channelId || !threadId) return null

  const messages = input.replies
    .map(reply => slackInteractionMessage(reply, input))
    .filter((message): message is SlackInteractionSinkMessage => Boolean(message))
    .sort((left, right) => compareSlackTs(left.provider_message_id, right.provider_message_id))
  if (messages.length === 0) return null

  return {
    workspace_id: workspaceId,
    channel_id: channelId,
    thread_id: threadId,
    surface_kind: channelId.startsWith('D') ? 'dm' : 'channel',
    messages,
    interaction_finished: isExplicitInteractionFinish(input.currentMessage.text)
  }
}

export async function sendSlackInteractionSnapshot(
  options: SlackbotV2Options,
  currentMessage: SlackbotV2ApiMessage,
  agentUsage: EvalUsageAttempt[] = [],
  overrides: { interactionFinished?: boolean } = {}
): Promise<SlackInteractionSnapshotResult> {
  const sink = options.interactionSink
  if (!sink) return { outcome: 'disabled' }
  const raw = asRecord(currentMessage.raw)
  const channel = stringValue(raw.channel) ?? threadPart(currentMessage.threadId, 1)
  const threadTs =
    stringValue(raw.thread_ts) ?? stringValue(raw.ts) ?? threadPart(currentMessage.threadId, 2)
  if (!channel || !threadTs) return { outcome: 'skipped' }

  const replies: JsonObject[] = []
  let cursor: string | undefined
  do {
    const page = await fetchSlackThreadReplies({
      apiUrl: options.slackApiUrl,
      channel,
      cursor,
      limit: 200,
      token: options.botToken,
      ts: threadTs
    })
    for (const message of Array.isArray(page.messages) ? page.messages : []) {
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        replies.push(message as JsonObject)
      }
    }
    cursor = page.nextCursor
  } while (cursor)

  const envelope = buildSlackInteractionEnvelope({
    botUserId: options.botUserId,
    currentMessage,
    replies,
    userName: options.userName
  })
  if (!envelope) return { outcome: 'skipped' }
  await enrichSlackIdentities(options, envelope)
  if (overrides.interactionFinished !== undefined) {
    envelope.interaction_finished = overrides.interactionFinished
  }

  const fetchFn = options.fetch ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), sink.timeoutMs ?? 5_000)
  try {
    const response = await fetchFn(sink.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sink.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ...envelope, agent_usage: agentUsage }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`interaction sink rejected the snapshot with HTTP ${response.status}`)
    }
    const payload: unknown = await response.json()
    return { chatObjectId: parseChatObjectId(payload), outcome: 'sent' }
  } finally {
    clearTimeout(timeout)
  }
}

async function enrichSlackIdentities(
  options: SlackbotV2Options,
  envelope: SlackInteractionSinkEnvelope
): Promise<void> {
  const ids = [...new Set(envelope.messages.map(message => message.sender.provider_user_id))]
    .slice(0, MAX_PROFILE_LOOKUPS_PER_SNAPSHOT)
  const profiles = new Map<string, SlackProfile>()
  if (options.interactionSink?.profileTtlMs !== undefined) {
    await Promise.all(ids.map(async id => {
      const profile = await resolveSlackProfile(options, id)
      if (profile) profiles.set(id, profile)
    }))
  }
  for (const message of envelope.messages) {
    const sender = message.sender
    const profile = profiles.get(sender.provider_user_id)
    if (profile?.displayName) sender.display_name = profile.displayName
    if (profile?.avatarUrl) sender.avatar_url = profile.avatarUrl
    if (profile) sender.profile_refreshed_at = profile.refreshedAt
    const override = sender.provider_user_id === options.botUserId
      ? options.interactionSink?.botIdentity
      : options.interactionSink?.identityOverrides?.[sender.provider_user_id]
    if (override?.displayName) sender.display_name = override.displayName
    if (override?.avatarAsset) {
      sender.avatar_asset = {
        sha256: override.avatarAsset.sha256,
        filename: override.avatarAsset.filename,
        provenance: override.avatarAsset.provenance ?? {}
      }
    }
  }
}

async function resolveSlackProfile(
  options: SlackbotV2Options,
  userId: string
): Promise<SlackProfile | undefined> {
  let cache = profileCaches.get(options)
  if (!cache) {
    cache = new Map()
    profileCaches.set(options, cache)
  }
  const now = Date.now()
  const cached = cache.get(userId)
  if (cached && cached.expiresAt > now) return cached.profile
  try {
    const url = new URL('users.info', options.slackApiUrl ?? 'https://slack.com/api/')
    url.searchParams.set('user', userId)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      options.slackApiTimeoutMs ?? 5_000
    )
    let response: Response
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${options.botToken}` },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) throw new Error(`users.info returned HTTP ${response.status}`)
    const payload = asRecord(await response.json())
    if (payload.ok !== true) throw new Error('users.info returned ok=false')
    const user = asRecord(payload.user)
    const rawProfile = asRecord(user.profile)
    const profile: SlackProfile = {
      displayName:
        stringValue(rawProfile.display_name_normalized)
        ?? stringValue(rawProfile.display_name)
        ?? stringValue(rawProfile.real_name_normalized)
        ?? stringValue(rawProfile.real_name)
        ?? stringValue(user.real_name)
        ?? stringValue(user.name),
      avatarUrl:
        stringValue(rawProfile.image_512)
        ?? stringValue(rawProfile.image_192)
        ?? stringValue(rawProfile.image_72)
        ?? stringValue(rawProfile.image_original),
      refreshedAt: new Date(now).toISOString()
    }
    cache.set(userId, {
      profile,
      expiresAt: now + (options.interactionSink?.profileTtlMs ?? 6 * 60 * 60 * 1_000)
    })
    return profile
  } catch {
    return cached?.profile
  }
}

function parseChatObjectId(payload: unknown): string {
  const data = asRecord(asRecord(payload).data)
  const value = stringValue(data.chat_object_id)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!value || !uuid.test(value)) {
    throw new Error('interaction sink response has an invalid chat_object_id')
  }
  return value
}

function slackInteractionMessage(
  message: JsonObject,
  input: {
    botUserId?: string
    currentMessage: SlackbotV2ApiMessage
    userName?: string
  }
): SlackInteractionSinkMessage | null {
  const id = stringValue(message.ts)
  const providerUserId = slackActorId(message)
  const rawText = stringValue(message.text) ?? ''
  const content = normalizeSlackSinkText(
    renderSlackDisplayText({ raw: message, text: rawText }).text
  )
  if (!id || !providerUserId || !content) return null
  const bot = Boolean(message.bot_id || message.bot_profile) || providerUserId === input.botUserId
  return {
    provider_message_id: id,
    sender: {
      provider_user_id: providerUserId,
      display_name: slackDisplayName(message, providerUserId, bot, input),
      user_kind: bot ? 'agent' : 'human'
    },
    content,
    source_created_at: slackTimestampToIso(id)
  }
}

function normalizeSlackSinkText(value: string): string {
  return value
    .replace(/<@([A-Z0-9]+)>/gi, '@$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function slackDisplayName(
  message: JsonObject,
  providerUserId: string,
  bot: boolean,
  input: {
    botUserId?: string
    currentMessage: SlackbotV2ApiMessage
    userName?: string
  }
): string {
  const profile = asRecord(message.bot_profile)
  const currentAuthor = input.currentMessage.author
  if (providerUserId === currentAuthor.userId) {
    return currentAuthor.fullName || currentAuthor.userName || providerUserId
  }
  if (bot) {
    return (
      stringValue(profile.name) ??
      stringValue(profile.real_name) ??
      (providerUserId === input.botUserId ? input.userName : undefined) ??
      providerUserId
    )
  }
  return providerUserId
}

function slackActorId(message: JsonObject): string | undefined {
  const profile = asRecord(message.bot_profile)
  return stringValue(profile.user_id) ?? stringValue(message.user) ?? stringValue(message.bot_id)
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function threadPart(threadId: string | undefined, index: number): string | undefined {
  const value = threadId?.split(':')[index]
  return value || undefined
}

function compareSlackTs(left: string, right: string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left.localeCompare(right)
}

function slackTimestampToIso(ts: string): string {
  const seconds = Number(ts)
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString()
}
