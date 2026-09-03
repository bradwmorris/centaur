import { createSlackbotV2, type SlackbotV2Options } from './index'
import { parseChannelDefaults } from './channel-defaults'
import { resolveSlackHomeTeamId } from './session-api'
import { resolveSlackBotUserId } from './slack-user'
import {
  createFlagMessageOverridesStrategy,
  createOpenAiMessageOverridesStrategy
} from './message-overrides-strategy'

const port = numberEnv('PORT', 3002)
const apiUrl = stringEnv('CENTAUR_API_URL', 'http://127.0.0.1:8080')
const botToken = requiredEnv('SLACK_BOT_TOKEN')
const signingSecret = requiredEnv('SLACK_SIGNING_SECRET')
const slackApiUrl = optionalEnv('SLACK_API_URL')
const slackApiTimeoutMs = optionalNumberEnv('SLACKBOTV2_SLACK_API_TIMEOUT_MS')
const instanceId = slackbotInstanceIdEnv()
const botUserId = await resolveSlackBotUserId({
  botToken,
  configuredBotUserId: optionalEnv('SLACK_BOT_USER_ID'),
  slackApiUrl,
  timeoutMs: slackApiTimeoutMs
})
const messageOverridesStrategyMode = messageOverridesStrategyModeEnv(
  'SLACKBOTV2_MESSAGE_OVERRIDES_STRATEGY'
)
const messageOverridesStrategyApiKey =
  optionalEnv('SLACKBOTV2_MESSAGE_OVERRIDES_OPENAI_API_KEY') ?? optionalEnv('OPENAI_API_KEY')

// Default to info: the chat adapter logs entire raw Slack webhook bodies at
// debug, and JSON-serializing those multi-hundred-KB payloads on the hot path
// blocks the event loop long enough to fail the 1s liveness probe.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const minLogLevel: (typeof LOG_LEVELS)[number] = (() => {
  const value = optionalEnv('SLACKBOTV2_LOG_LEVEL')?.toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(value ?? '')
    ? (value as (typeof LOG_LEVELS)[number])
    : 'info'
})()

const consoleLogger = {
  debug: (message: string, data?: unknown) => log('debug', message, data),
  info: (message: string, data?: unknown) => log('info', message, data),
  warn: (message: string, data?: unknown) => log('warn', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  child: () => consoleLogger
}

const options: SlackbotV2Options = {
  apiUrl,
  apiKey: optionalEnv('SLACKBOT_API_KEY'),
  assistantStatus: optionalEnv('SLACKBOTV2_ASSISTANT_STATUS'),
  activitySummaryStatusEnabled: booleanEnv('SLACKBOTV2_ACTIVITY_SUMMARY_STATUS_ENABLED', false),
  autoJoinCreatedChannels: booleanEnv('SLACKBOTV2_AUTO_JOIN_CREATED_CHANNELS', false),
  botToken,
  botUserId,
  channelDefaults: parseChannelDefaults(optionalEnv('SLACKBOTV2_CHANNEL_DEFAULTS'), reason =>
    consoleLogger.warn('slackbotv2 SLACKBOTV2_CHANNEL_DEFAULTS', { reason })
  ),
  codexNanocodexRolloutPercent: percentEnv(
    'SLACKBOTV2_CODEX_NANOCODEX_ROLLOUT_PERCENT',
    0
  ),
  consolePublicUrl: optionalEnv('CENTAUR_CONSOLE_PUBLIC_URL'),
  responseMetadataMode: responseMetadataModeEnv('SLACKBOTV2_RESPONSE_METADATA_MODE'),
  responseServiceTierEnabled: booleanEnv('SLACKBOTV2_RESPONSE_SERVICE_TIER_ENABLED', false),
  executeSubscribedReplies: booleanEnv('SLACKBOTV2_EXECUTE_SUBSCRIBED_REPLIES', false),
  freshSessionPerTurn: booleanEnv('SLACKBOTV2_FRESH_SESSION_PER_TURN', false),
  defaultHarnessType: optionalEnv('SLACKBOTV2_DEFAULT_HARNESS'),
  // Same env vars deployers use to override the sandbox harness model
  // (sandbox.extraEnv); the chart mirrors them here so displayed defaults
  // track the deployment instead of the baked harness config.
  harnessDefaultModels: {
    ...(optionalEnv('CLAUDE_MODEL') ? { claudecode: optionalEnv('CLAUDE_MODEL')! } : {}),
    ...(optionalEnv('CODEX_MODEL')
      ? { codex: optionalEnv('CODEX_MODEL')!, nanocodex: optionalEnv('CODEX_MODEL')! }
      : {})
  },
  harnessDefaultReasoning: optionalEnv('CODEX_MODEL_REASONING_EFFORT')
    ? {
        codex: optionalEnv('CODEX_MODEL_REASONING_EFFORT')!,
        nanocodex: optionalEnv('CODEX_MODEL_REASONING_EFFORT')!
      }
    : {},
  idleTimeoutMs: optionalNumberEnv('SESSION_IDLE_TIMEOUT_MS'),
  instanceId,
  contextBuilder: contextBuilderEnv(),
  interactionSink: interactionSinkEnv(),
  maxDurationMs: optionalNumberEnv('SESSION_MAX_DURATION_MS'),
  messageOverridesStrategy: createMessageOverridesStrategy(),
  postgresUrl:
    optionalEnv('SLACKBOTV2_DATABASE_URL') ??
    optionalEnv('DATABASE_URL') ??
    optionalEnv('POSTGRES_URL'),
  personaId: optionalEnv('SLACKBOTV2_PERSONA_ID'),
  renderRecoveryMaxObligationAgeMs: optionalNumberEnv(
    'SLACKBOTV2_RENDER_RECOVERY_MAX_OBLIGATION_AGE_MS'
  ),
  sessionApiTimeoutMs: optionalNumberEnv('SLACKBOTV2_SESSION_API_TIMEOUT_MS'),
  signingSecret,
  slackApiUrl,
  slackApiTimeoutMs,
  stateKeyPrefix:
    optionalEnv('SLACKBOTV2_STATE_KEY_PREFIX')
    ?? (instanceId ? `centaur-slackbotv2:${instanceId}` : undefined),
  userName: stringEnv('SLACKBOTV2_USER_NAME', 'centaur'),
  logger: consoleLogger
}
options.slackHomeTeamId = await resolveSlackHomeTeamId(options)

const { app } = createSlackbotV2(options)
const server = Bun.serve({
  port,
  fetch: app.fetch
})

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'slackbotv2_started',
    service: 'slackbotv2',
    instance_id: options.instanceId,
    persona_id: options.personaId,
    activity_summary_status_enabled: options.activitySummaryStatusEnabled,
    auto_join_created_channels_enabled: options.autoJoinCreatedChannels,
    execute_subscribed_replies_enabled: options.executeSubscribedReplies,
    fresh_session_per_turn_enabled: options.freshSessionPerTurn,
    message_overrides_strategy: messageOverridesStrategyMode,
    message_overrides_strategy_enabled:
      messageOverridesStrategyMode !== 'llm' || Boolean(messageOverridesStrategyApiKey),
    response_metadata_mode: options.responseMetadataMode,
    response_service_tier_enabled: options.responseServiceTierEnabled,
    port: server.port,
    api_url: apiUrl
  })
)

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name)
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function stringEnv(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback
}

function numberEnv(name: string, fallback: number): number {
  return optionalNumberEnv(name) ?? fallback
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name)
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  throw new Error(`${name} must be a boolean`)
}

function messageOverridesStrategyModeEnv(name: string): 'flags' | 'llm' {
  const value = optionalEnv(name)?.toLowerCase()
  if (!value) return 'flags'
  if (value === 'flags' || value === 'llm') return value
  throw new Error(`${name} must be "flags" or "llm"`)
}

function responseMetadataModeEnv(name: string): 'first' | 'always' | 'never' {
  const value = optionalEnv(name)?.toLowerCase()
  if (!value) return 'first'
  if (value === 'first' || value === 'always' || value === 'never') return value
  throw new Error(`${name} must be "first", "always", or "never"`)
}

function percentEnv(name: string, fallback: number): number {
  const value = optionalEnv(name)
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be an integer from 0 to 100`)
  }
  return parsed
}

function createMessageOverridesStrategy(): SlackbotV2Options['messageOverridesStrategy'] {
  if (messageOverridesStrategyMode !== 'llm') return createFlagMessageOverridesStrategy()
  if (!messageOverridesStrategyApiKey) {
    return async () => ({ overrides: {} })
  }
  return createOpenAiMessageOverridesStrategy({
    apiKey: messageOverridesStrategyApiKey,
    baseUrl: optionalEnv('SLACKBOTV2_MESSAGE_OVERRIDES_OPENAI_BASE_URL'),
    logger: consoleLogger,
    maxOutputTokens: optionalNumberEnv('SLACKBOTV2_MESSAGE_OVERRIDES_MAX_OUTPUT_TOKENS'),
    model: stringEnv('SLACKBOTV2_MESSAGE_OVERRIDES_MODEL', 'gpt-5.4-nano'),
    timeoutMs: optionalNumberEnv('SLACKBOTV2_MESSAGE_OVERRIDES_TIMEOUT_MS')
  })
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name)
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function interactionSinkEnv(): SlackbotV2Options['interactionSink'] {
  const url = optionalEnv('SLACKBOTV2_INTERACTION_SINK_URL')
  const token = optionalEnv('SLACKBOTV2_INTERACTION_SINK_TOKEN')
  if (!url && !token) return undefined
  if (!url || !token) {
    throw new Error(
      'SLACKBOTV2_INTERACTION_SINK_URL and SLACKBOTV2_INTERACTION_SINK_TOKEN must be set together'
    )
  }
  return {
    url,
    token,
    timeoutMs: optionalNumberEnv('SLACKBOTV2_INTERACTION_SINK_TIMEOUT_MS'),
    profileTtlMs: optionalNumberEnv('SLACKBOTV2_INTERACTION_SINK_PROFILE_TTL_MS'),
    botIdentity: identityOverrideEnv('SLACKBOTV2_INTERACTION_SINK_BOT_IDENTITY'),
    identityOverrides: identityOverridesEnv(
      'SLACKBOTV2_INTERACTION_SINK_IDENTITY_OVERRIDES'
    ),
    usage: {
      provider: stringEnv('SLACKBOTV2_INTERACTION_SINK_USAGE_PROVIDER', 'unknown'),
      authMode: enumEnv(
        'SLACKBOTV2_INTERACTION_SINK_USAGE_AUTH_MODE',
        ['chatgpt_subscription', 'api_key', 'not_applicable', 'unknown'] as const,
        'unknown'
      ),
      billingMode: enumEnv(
        'SLACKBOTV2_INTERACTION_SINK_USAGE_BILLING_MODE',
        ['subscription_allowance', 'chatgpt_credits', 'metered_api', 'not_applicable', 'unknown'] as const,
        'unknown'
      ),
      upstreamService: stringEnv(
        'SLACKBOTV2_INTERACTION_SINK_USAGE_UPSTREAM_SERVICE',
        'unknown'
      )
    }
  }
}

function identityOverrideEnv(
  name: string
): NonNullable<SlackbotV2Options['interactionSink']>['botIdentity'] {
  const value = optionalEnv(name)
  if (!value) return undefined
  const parsed: unknown = JSON.parse(value)
  validateIdentityOverride(name, parsed)
  return parsed as NonNullable<SlackbotV2Options['interactionSink']>['botIdentity']
}

function identityOverridesEnv(
  name: string
): NonNullable<SlackbotV2Options['interactionSink']>['identityOverrides'] {
  const value = optionalEnv(name)
  if (!value) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object keyed by Slack user ID`)
  }
  for (const [userId, override] of Object.entries(parsed)) {
    if (!userId.trim()) throw new Error(`${name} contains an empty Slack user ID`)
    validateIdentityOverride(`${name}.${userId}`, override)
  }
  return parsed as NonNullable<SlackbotV2Options['interactionSink']>['identityOverrides']
}

function validateIdentityOverride(name: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`)
  }
  const override = value as Record<string, unknown>
  if (
    override.displayName !== undefined
    && (typeof override.displayName !== 'string' || !override.displayName.trim())
  ) {
    throw new Error(`${name}.displayName must be a non-empty string`)
  }
  if (override.avatarAsset !== undefined) {
    const asset = override.avatarAsset as Record<string, unknown>
    if (
      !asset
      || typeof asset !== 'object'
      || Array.isArray(asset)
      || typeof asset.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(asset.sha256)
      || typeof asset.filename !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.filename)
      || asset.filename.includes('..')
    ) {
      throw new Error(`${name}.avatarAsset must contain a safe lowercase SHA-256 and filename`)
    }
  }
}

function enumEnv<const T extends readonly string[]>(
  name: string,
  values: T,
  fallback: T[number]
): T[number] {
  const value = optionalEnv(name) ?? fallback
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of ${values.join(', ')}`)
  }
  return value
}

function slackbotInstanceIdEnv(): string | undefined {
  const value = optionalEnv('SLACKBOTV2_INSTANCE_ID')
  if (value && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error('SLACKBOTV2_INSTANCE_ID must be a lowercase DNS label')
  }
  return value
}

function contextBuilderEnv(): SlackbotV2Options['contextBuilder'] {
  const url = optionalEnv('SLACKBOTV2_CONTEXT_BUILDER_URL')
  const token = optionalEnv('SLACKBOTV2_CONTEXT_BUILDER_TOKEN')
  if (!url && !token) return undefined
  if (!url || !token) {
    throw new Error(
      'SLACKBOTV2_CONTEXT_BUILDER_URL and SLACKBOTV2_CONTEXT_BUILDER_TOKEN must be set together'
    )
  }
  return {
    url,
    token,
    limit: optionalNumberEnv('SLACKBOTV2_CONTEXT_BUILDER_LIMIT'),
    timeoutMs: optionalNumberEnv('SLACKBOTV2_CONTEXT_BUILDER_TIMEOUT_MS')
  }
}

function log(level: (typeof LOG_LEVELS)[number], message: string, data?: unknown): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(minLogLevel)) return
  console.log(
    JSON.stringify({
      level,
      service: 'slackbotv2',
      timestamp: new Date().toISOString(),
      event: message,
      ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : {})
    })
  )
}
