import { describe, expect, test } from 'bun:test'
import { finalizeRunTrace, InteractionRunTraceCollector } from '../src/run-trace'
import type { SlackbotV2Trace } from '../src/types'

function trace(): SlackbotV2Trace {
  return {
    includeContext: true,
    messageId: '1780000001.000100',
    mode: 'execute',
    openStream: true,
    startedAtMs: 1,
    threadId: 'slack:T:C:1780000000.000100',
    runEntries: []
  }
}

describe('interaction Run trace', () => {
  test('captures safe tool facts and resulting Object IDs without arguments or output', () => {
    const run = trace()
    const collector = new InteractionRunTraceCollector(run)
    collector.capture({
      eventKind: 'session.output.line',
      data: JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-1',
            type: 'mcpToolCall',
            name: 'create_note',
            arguments: { private_text: 'do not persist this' },
            result: {
              object_id: '00000000-0000-4000-8000-000000000123',
              content: 'also private'
            },
            status: 'completed'
          }
        }
      })
    })

    expect(run.runEntries).toHaveLength(1)
    expect(run.runEntries![0]).toMatchObject({
      entry_type: 'tool_call',
      name: 'create_note',
      status: 'completed'
    })
    expect(JSON.stringify(run.runEntries![0])).not.toContain('private')
    expect(collector.affectedObjectIds()).toEqual([
      '00000000-0000-4000-8000-000000000123'
    ])
  })

  test('updates a started tool entry when the same item completes', () => {
    const run = trace()
    const collector = new InteractionRunTraceCollector(run)
    for (const method of ['item/started', 'item/completed']) {
      collector.capture({
        eventKind: 'session.output.line',
        data: JSON.stringify({ method, params: { item: { id: 'tool-1', type: 'dynamicToolCall', name: 'search' } } })
      })
    }
    expect(run.runEntries).toHaveLength(1)
    expect(run.runEntries![0]?.status).toBe('completed')
  })

  test('closes any still-running spans when the interaction finishes', () => {
    const run = trace()
    run.runEntries = [{ id: 'execution-1', status: 'running' }]
    finalizeRunTrace(run, 'completed')
    expect(run.runEntries[0]).toMatchObject({ status: 'completed' })
    expect(run.runEntries[0]?.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
