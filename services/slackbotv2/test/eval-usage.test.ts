import { describe, expect, test } from 'bun:test'
import { EvalUsageCollector } from '../src/eval-usage'

function collector() {
  return new EvalUsageCollector({
    component: 'centaur_agent',
    provider: 'openai',
    model_id: 'gpt-5.6-sol',
    display_tier: 'GPT-5.6 Sol',
    execution_type: 'codex_harness',
    auth_mode: 'chatgpt_subscription',
    upstream_service: 'chatgpt.com',
    billing_mode: 'subscription_allowance',
    reasoning_effort: 'high',
    source_thread_id: 'slack:T1:C1:thread',
    source_execution_id: 'execution-1'
  })
}

describe('eval usage producer contract', () => {
  test('normalizes Codex usage and merges replayed updates for one execution turn', () => {
    const usage = collector()
    usage.capture({
      eventKind: 'session.output.line',
      eventId: 1,
      data: JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 20 } } }
      })
    })
    usage.capture({
      eventKind: 'session.output.line',
      eventId: 2,
      data: JSON.stringify({
        type: 'turn.completed',
        turn: { id: 'turn-1' },
        usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 150 }
      })
    })
    const attempts = usage.finish()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      auth_mode: 'chatgpt_subscription',
      billing_mode: 'subscription_allowance',
      source_execution_id: 'execution-1',
      source_turn_id: 'turn-1',
      input_tokens: 100,
      cache_read_tokens: 20,
      output_tokens: 50,
      reasoning_tokens: 10,
      total_tokens: 150,
      usage_status: 'reported'
    })
    expect(attempts[0]).not.toHaveProperty('estimated_micro_usd')
  })

  test('reports missing usage explicitly instead of silently recording zero', () => {
    const [attempt] = collector().finish('fixture did not emit usage')
    expect(attempt).toMatchObject({
      usage_status: 'unavailable',
      usage_missing_reason: 'fixture did not emit usage'
    })
    expect(attempt).not.toHaveProperty('input_tokens')
    expect(attempt).not.toHaveProperty('total_tokens')
  })

  test('normalizes Anthropic cache categories without adding them into totals', () => {
    const usage = collector()
    usage.capture({
      eventKind: 'session.output.line',
      data: JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-fable-5',
          usage: {
            input_tokens: 80,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
            output_tokens: 30
          }
        }
      })
    })
    expect(usage.finish()[0]).toMatchObject({
      model_id: 'claude-fable-5',
      input_tokens: 80,
      cache_creation_tokens: 10,
      cache_read_tokens: 20,
      output_tokens: 30
    })
  })
})
