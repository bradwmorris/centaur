/**
 * Per-channel default harness / model / provider / reasoning and optional project persona. Loaded from the
 * `SLACKBOTV2_CHANNEL_DEFAULTS` env var: JSON keyed by Slack conversation id,
 * each value an object normalized like the inline flags (see
 * `normalizeHarnessOverrides`):
 *
 *   SLACKBOTV2_CHANNEL_DEFAULTS='{
 *     "C0ENG":     {"harness": "claude", "model": "opus", "reasoning": "high"},
 *     "C0TRIAGE":  {"reasoning": "low"},
 *     "C0BEDROCK": {"provider": "bedrock", "model": "gpt-5.2"}
 *   }'
 *
 * Fields are independent. Precedence (in index.ts): per-thread override, then
 * channel default, then deployment default. Setting `harness` restarts a thread
 * onto it like `--claude`/`--codex`; `reasoning` affects Codex and Nanocodex.
 */

import { normalizeHarnessOverrides, type HarnessOverrides } from './overrides'

export type ChannelDefault = HarnessOverrides & { mentionless?: boolean }
export type ChannelDefaults = Record<string, ChannelDefault>

/**
 * Parses `SLACKBOTV2_CHANNEL_DEFAULTS` into a channel→overrides map (empty for
 * unset input). Invalid project settings throw to prevent incorrect routing; other invalid entries are reported via
 * `onError`.
 */
export function parseChannelDefaults(
  raw: string | undefined,
  onError?: (message: string) => void
): ChannelDefaults {
  const trimmed = raw?.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    onError?.(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  if (!isPlainObject(parsed)) {
    onError?.('expected a JSON object keyed by channel id')
    return {}
  }
  const result: ChannelDefaults = {}
  for (const [channelId, rawEntry] of Object.entries(parsed)) {
    const key = channelId.trim()
    if (!key) continue
    if (!isPlainObject(rawEntry)) {
      onError?.(`channel ${key}: expected an object of harness/model/provider/reasoning fields`)
      continue
    }
    const overrides = normalizeHarnessOverrides(rawEntry, message => onError?.(`channel ${key}: ${message}`))
    if (rawEntry.persona !== undefined) {
      if (typeof rawEntry.persona !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(rawEntry.persona)) {
        throw new Error(`channel ${key}: invalid persona`)
      }
      overrides.personaId = rawEntry.persona
    }
    if (rawEntry.mentionless !== undefined && typeof rawEntry.mentionless !== 'boolean') {
      throw new Error(`channel ${key}: mentionless must be a boolean`)
    }
    if (!overrides.personaId && rawEntry.mentionless !== true && !overrides.harnessType && !overrides.model && !overrides.provider && !overrides.reasoning) {
      onError?.(`channel ${key}: no usable harness/model/provider/reasoning fields`)
      continue
    }
    result[key] = { ...overrides, ...(rawEntry.mentionless !== undefined ? { mentionless: rawEntry.mentionless as boolean } : {}) }
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extracts the Slack conversation id from a thread key of the shape
 * `slack:CHANNEL[:THREAD_TS]` (or `slack:TEAM:CHANNEL:…`), mirroring the
 * classification in session-api's `slackConversationId`: the first segment
 * after the namespace whose first character is `C`, `G`, or `D`.
 */
export function channelIdFromThreadId(threadId: string): string | undefined {
  const segments = threadId.split(':').slice(1)
  for (const segment of segments) {
    const first = segment.charAt(0)
    if (first === 'C' || first === 'G' || first === 'D') return segment
  }
  return undefined
}

/** Resolves the channel default for a thread, or undefined when none applies. */
export function resolveChannelDefault(
  defaults: ChannelDefaults | undefined,
  threadId: string
): ChannelDefault | undefined {
  if (!defaults) return undefined
  const channelId = channelIdFromThreadId(threadId)
  if (!channelId) return undefined
  return defaults[channelId]
}

/** Only configured channels may treat human messages as implicit mentions. */
export function acceptsUnmentionedMessage(defaults: ChannelDefaults | undefined, threadId: string, message: { author: { isBot?: boolean | 'unknown' }; raw: unknown }): boolean {
  const raw = isPlainObject(message.raw) ? message.raw : {}
  return resolveChannelDefault(defaults, threadId)?.mentionless === true
    && message.author.isBot !== true && !raw.bot_id && !raw.bot_profile
    && (!raw.subtype || raw.subtype === 'file_share')
}

export function resolveProjectPersona(configured: string | undefined, requested: string | undefined, pinned: string | null | undefined): string | undefined {
  if (!configured) return undefined
  if (requested && requested !== configured) throw new Error('This channel has a fixed project; start work in the destination project channel.')
  if (pinned !== undefined && pinned !== configured) throw new Error('This thread belongs to an older project configuration; start a new thread.')
  return configured
}
