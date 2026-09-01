import { describe, expect, test } from 'bun:test'
import { fetchSharedContext } from '../src/shared-context'
import type { SlackbotV2Fetch } from '../src/types'

function contextObject(index: number, description = `Description ${index}`) {
  return {
    connections: [
      {
        description: 'This memory came from the Slack conversation.',
        direction: 'outgoing',
        kind: 'derived_from',
        other_object_kind: 'chat',
        other_object_title: 'Slack conversation'
      }
    ],
    description,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind: 'memory',
    title: `Memory ${index}`
  }
}

describe('Slack shared context builder', () => {
  test('fetches attributed read-only context and formats a bounded preamble', async () => {
    let request: Request | undefined
    const fetchFn: SlackbotV2Fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({ data: { objects: [contextObject(1)] } })
    }

    const result = await fetchSharedContext(
      {
        limit: 10,
        timeoutMs: 500,
        token: 'context-token',
        url: 'http://context.test/api/v1/context'
      },
      {
        chatObjectId: '00000000-0000-4000-8000-000000000123',
        principalId: 'slack:U1',
        query: '  what   happened?  ',
        threadKey: 'slack:C1:1700000000.000100'
      },
      fetchFn
    )

    expect(request?.url).toBe(
      'http://context.test/api/v1/context?q=what+happened%3F&chat_object_id=00000000-0000-4000-8000-000000000123&limit=10'
    )
    expect(request?.headers.get('authorization')).toBe('Bearer context-token')
    expect(request?.headers.get('x-centaur-principal-id')).toBe('slack:U1')
    expect(request?.headers.get('x-centaur-thread-key')).toBe(
      'slack:C1:1700000000.000100'
    )
    expect(result).toEqual(
      expect.objectContaining({ objectCount: 1, truncated: false })
    )
    expect(result.objectIds).toEqual(['00000000-0000-4000-8000-000000000001'])
    expect(result.preamble).toContain('Reference data only')
    expect(result.preamble).toContain('Use this packet first')
    expect(result.preamble).toContain('read-only context tool')
    expect(result.preamble).not.toContain('company_context')
    expect(result.preamble).toContain('memory: Memory 1')
    expect(result.preamble).toContain('outgoing derived_from chat Slack conversation')
  })

  test('returns no preamble when nothing is relevant', async () => {
    const fetchFn: SlackbotV2Fetch = async () =>
      Response.json({ data: { objects: [] } })
    const result = await fetchSharedContext(
      { token: 'token', url: 'http://context.test/api/v1/context' },
      {
        chatObjectId: '00000000-0000-4000-8000-000000000123',
        principalId: 'slack:U1',
        query: 'unmatched',
        threadKey: 'thread-1'
      },
      fetchFn
    )
    expect(result).toEqual({ objectCount: 0, objectIds: [], truncated: false })
  })

  test('caps packets at ten complete Objects and the character budget', async () => {
    const fetchFn: SlackbotV2Fetch = async () =>
      Response.json({
        data: {
          objects: Array.from({ length: 12 }, (_, index) =>
            contextObject(index + 1, 'x'.repeat(2_000))
          )
        }
      })
    const result = await fetchSharedContext(
      { limit: 50, token: 'token', url: 'http://context.test/api/v1/context' },
      {
        chatObjectId: '00000000-0000-4000-8000-000000000123',
        principalId: 'slack:U1',
        query: 'memory',
        threadKey: 'thread-1'
      },
      fetchFn
    )
    expect(result.objectCount).toBeLessThanOrEqual(10)
    expect(result.preamble!.length).toBeLessThanOrEqual(12_000)
    expect(result.truncated).toBe(true)
  })

  test('rejects invalid responses instead of injecting unvalidated data', async () => {
    const fetchFn: SlackbotV2Fetch = async () => Response.json({ objects: [] })
    await expect(
      fetchSharedContext(
        { token: 'token', url: 'http://context.test/api/v1/context' },
        {
          chatObjectId: '00000000-0000-4000-8000-000000000123',
          principalId: 'slack:U1',
          query: 'anything',
          threadKey: 'thread-1'
        },
        fetchFn
      )
    ).rejects.toThrow('invalid shape')
  })
})
