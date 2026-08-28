import { describe, expect, test } from 'bun:test'
import {
  buildSlackInteractionEnvelope,
  isExplicitInteractionFinish,
  sendSlackInteractionSnapshot,
  type SlackInteractionSinkEnvelope
} from '../src/interaction-sink'
import type { JsonObject, SlackbotV2ApiMessage, SlackbotV2Options } from '../src/types'

function currentMessage(text = '<@UAGENT> finished'): SlackbotV2ApiMessage {
  return {
    attachments: [],
    author: {
      fullName: 'Example Human',
      isBot: false,
      isMe: false,
      userId: 'UHUMAN',
      userName: 'example-human'
    },
    id: '1780000001.000100',
    isMention: true,
    raw: {
      channel: 'C_APPROVED',
      team: 'T_PUBLIC',
      thread_ts: '1780000000.000100',
      ts: '1780000001.000100',
      user: 'UHUMAN'
    },
    teamId: 'T_PUBLIC',
    text,
    threadId: 'slack:C_APPROVED:1780000000.000100',
    timestamp: '2026-05-27T00:00:01Z'
  }
}

describe('Slack interaction sink envelope', () => {
  test('normalizes and orders a human/agent thread snapshot', () => {
    const replies: JsonObject[] = [
      {
        bot_id: 'B_AGENT',
        bot_profile: { name: 'Centaur Agent', user_id: 'UAGENT' },
        text: 'The interaction is recorded.',
        ts: '1780000002.000100'
      },
      {
        text: '<@UAGENT> finished',
        ts: '1780000001.000100',
        user: 'UHUMAN'
      }
    ]
    const envelope = buildSlackInteractionEnvelope({
      botUserId: 'UAGENT',
      currentMessage: currentMessage(),
      replies,
      userName: 'centaur'
    })

    expect(envelope).toEqual({
      workspace_id: 'T_PUBLIC',
      channel_id: 'C_APPROVED',
      thread_id: '1780000000.000100',
      surface_kind: 'channel',
      interaction_finished: true,
      messages: [
        {
          provider_message_id: '1780000001.000100',
          sender: {
            provider_user_id: 'UHUMAN',
            display_name: 'Example Human',
            user_kind: 'human'
          },
          content: '@UAGENT finished',
          source_created_at: '2026-05-28T20:26:41.000Z'
        },
        {
          provider_message_id: '1780000002.000100',
          sender: {
            provider_user_id: 'UAGENT',
            display_name: 'Centaur Agent',
            user_kind: 'agent'
          },
          content: 'The interaction is recorded.',
          source_created_at: '2026-05-28T20:26:42.000Z'
        }
      ]
    })
  })

  test('recognizes only an explicit simple finish signal', () => {
    expect(isExplicitInteractionFinish('finished')).toBe(true)
    expect(isExplicitInteractionFinish('<@UAGENT> Done.')).toBe(true)
    expect(isExplicitInteractionFinish('I finished the draft')).toBe(false)
  })

  test('fails closed when the Slack identity boundary is incomplete', () => {
    const current = currentMessage('continue')
    current.teamId = ''
    current.raw = {}
    current.threadId = ''
    expect(
      buildSlackInteractionEnvelope({ currentMessage: current, replies: [] })
    ).toBeNull()
  })

  test('fetches the rendered thread and sends it with the sink credential', async () => {
    const slack = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe('/api/conversations.replies')
        return Response.json({
          ok: true,
          messages: [
            { text: '<@UAGENT> finished', ts: '1780000001.000100', user: 'UHUMAN' },
            {
              bot_id: 'BAGENT',
              bot_profile: { name: 'Centaur Agent', user_id: 'UAGENT' },
              text: 'The interaction is recorded.',
              ts: '1780000002.000100'
            }
          ],
          response_metadata: { next_cursor: '' }
        })
      }
    })
    let sinkRequest: { authorization?: string; body?: SlackInteractionSinkEnvelope } = {}
    try {
      const options: SlackbotV2Options = {
        apiUrl: 'http://session.test',
        botToken: 'xoxb-test',
        botUserId: 'UAGENT',
        signingSecret: 'test-signing-secret',
        slackApiUrl: `http://127.0.0.1:${slack.port}/api/`,
        interactionSink: {
          url: 'http://centaur-os.test/api/v1/ingest/slack/interactions',
          token: 'i'.repeat(32)
        },
        fetch: async (_input, init) => {
          sinkRequest = {
            authorization: new Headers(init?.headers).get('authorization') ?? undefined,
            body: JSON.parse(String(init?.body)) as SlackInteractionSinkEnvelope
          }
          return Response.json({ data: { accepted: true } }, { status: 202 })
        }
      }
      expect(await sendSlackInteractionSnapshot(options, currentMessage())).toBe('sent')
      expect(sinkRequest.authorization).toBe(`Bearer ${'i'.repeat(32)}`)
      expect(sinkRequest.body?.messages).toHaveLength(2)
      expect(sinkRequest.body?.interaction_finished).toBe(true)
    } finally {
      slack.stop(true)
    }
  })
})
