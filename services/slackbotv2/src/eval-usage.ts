import type { SlackbotV2RendererSource } from './types'
import type { InteractionRunTraceCollector } from './run-trace'

export type EvalUsageAttempt = {
  component: string
  provider: string
  model_id: string
  display_tier?: string
  execution_type: 'codex_harness' | 'direct_api' | 'embedding' | 'other'
  auth_mode: 'chatgpt_subscription' | 'api_key' | 'not_applicable' | 'unknown'
  upstream_service: string
  billing_mode:
    | 'subscription_allowance'
    | 'chatgpt_credits'
    | 'metered_api'
    | 'not_applicable'
    | 'unknown'
  reasoning_effort?: string
  service_tier?: string
  source_thread_id?: string
  source_execution_id: string
  source_turn_id?: string
  usage_status: 'reported' | 'partial' | 'unavailable' | 'not_applicable'
  usage_missing_reason?: string
  input_tokens?: number
  output_tokens?: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
  reasoning_tokens?: number
  total_tokens?: number
}

export type EvalUsageMetadata = Omit<
  EvalUsageAttempt,
  | 'usage_status'
  | 'usage_missing_reason'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_creation_tokens'
  | 'cache_read_tokens'
  | 'reasoning_tokens'
  | 'total_tokens'
  | 'source_turn_id'
>

type Counts = Pick<
  EvalUsageAttempt,
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_creation_tokens'
  | 'cache_read_tokens'
  | 'reasoning_tokens'
  | 'total_tokens'
>

export class EvalUsageCollector {
  readonly #metadata: EvalUsageMetadata
  readonly #attempts = new Map<string, EvalUsageAttempt>()

  constructor(metadata: EvalUsageMetadata) {
    this.#metadata = metadata
  }

  capture(source: SlackbotV2RendererSource): void {
    const payload = outputPayload(source)
    if (!payload) return
    const usage = usageRecord(payload)
    if (!usage) return
    const counts = tokenCounts(usage)
    if (!Object.values(counts).some(value => value !== undefined)) return
    const sourceTurnId = turnId(payload)
    const key = sourceTurnId ?? 'execution'
    const existing =
      this.#attempts.get(key) ?? (sourceTurnId ? this.#attempts.get('execution') : undefined)
    if (sourceTurnId) this.#attempts.delete('execution')
    this.#attempts.set(key, {
      ...this.#metadata,
      ...(existing ?? {}),
      model_id: modelId(payload) ?? existing?.model_id ?? this.#metadata.model_id,
      display_tier: modelId(payload) ?? existing?.display_tier ?? this.#metadata.display_tier,
      source_turn_id: sourceTurnId,
      usage_status: completeCounts(counts) ? 'reported' : 'partial',
      usage_missing_reason: completeCounts(counts)
        ? undefined
        : 'The harness reported only a subset of token categories.',
      ...definedCounts(existing, counts)
    })
  }

  finish(missingReason = 'The execution emitted no normalized token usage.'): EvalUsageAttempt[] {
    if (this.#attempts.size > 0) return [...this.#attempts.values()]
    return [
      {
        ...this.#metadata,
        usage_status: 'unavailable',
        usage_missing_reason: missingReason
      }
    ]
  }
}

export async function* captureEvalUsage(
  sources: AsyncIterable<SlackbotV2RendererSource>,
  collector: EvalUsageCollector,
  runTrace?: InteractionRunTraceCollector
): AsyncIterable<SlackbotV2RendererSource> {
  for await (const source of sources) {
    collector.capture(source)
    runTrace?.capture(source)
    yield source
  }
}

function outputPayload(source: SlackbotV2RendererSource): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  const raw = record.eventKind === 'session.output.line' ? record.data : record
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return asRecord(parsed)
    } catch {
      return undefined
    }
  }
  return asRecord(raw)
}

function usageRecord(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const params = asRecord(payload.params)
  const tokenUsage = asRecord(params?.tokenUsage ?? params?.token_usage)
  return (
    asRecord(tokenUsage?.last) ??
    asRecord(payload.usage) ??
    asRecord(asRecord(payload.message)?.usage) ??
    asRecord(asRecord(payload.result)?.usage)
  )
}

function tokenCounts(usage: Record<string, unknown>): Counts {
  return {
    input_tokens: count(usage, ['input_tokens', 'inputTokens', 'inputTokenCount']),
    output_tokens: count(usage, ['output_tokens', 'outputTokens', 'outputTokenCount']),
    cache_creation_tokens: count(usage, [
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
      'cache_creation_tokens'
    ]),
    cache_read_tokens: count(usage, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cached_input_tokens',
      'cachedInputTokens'
    ]),
    reasoning_tokens: count(usage, [
      'reasoning_output_tokens',
      'reasoningOutputTokens',
      'reasoning_tokens',
      'reasoningTokens'
    ]),
    total_tokens: count(usage, ['total_tokens', 'totalTokens', 'totalTokenCount'])
  }
}

function definedCounts(existing: EvalUsageAttempt | undefined, next: Counts): Counts {
  return {
    input_tokens: next.input_tokens ?? existing?.input_tokens,
    output_tokens: next.output_tokens ?? existing?.output_tokens,
    cache_creation_tokens: next.cache_creation_tokens ?? existing?.cache_creation_tokens,
    cache_read_tokens: next.cache_read_tokens ?? existing?.cache_read_tokens,
    reasoning_tokens: next.reasoning_tokens ?? existing?.reasoning_tokens,
    total_tokens: next.total_tokens ?? existing?.total_tokens
  }
}

function completeCounts(counts: Counts): boolean {
  return counts.input_tokens !== undefined && counts.output_tokens !== undefined
}

function modelId(payload: Record<string, unknown>): string | undefined {
  return text(payload.model) ?? text(asRecord(payload.message)?.model)
}

function turnId(payload: Record<string, unknown>): string | undefined {
  const params = asRecord(payload.params)
  return (
    text(asRecord(payload.turn)?.id) ??
    text(params?.turnId) ??
    text(params?.turn_id) ??
    text(payload.turn_id)
  )
}

function count(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) {
      return candidate
    }
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
