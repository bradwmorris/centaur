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
    expect(isExplicitInteractionFinish('@UAGENT done')).toBe(true)
    expect(isExplicitInteractionFinish('I finished the draft')).toBe(false)
    expect(isExplicitInteractionFinish('`@Centaur Test done`')).toBe(false)
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
        const url = new URL(request.url)
        if (url.pathname === '/api/users.info') {
          const user = url.searchParams.get('user')
          return Response.json({
            ok: true,
            user: {
              id: user,
              name: user,
              profile: { display_name: user, image_192: `https://avatar.test/${user}.png` }
            }
          })
        }
        expect(url.pathname).toBe('/api/conversations.replies')
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
          url: 'http://centaur-context.test/api/v1/ingest/slack/interactions',
          token: 'i'.repeat(32)
        },
        fetch: async (_input, init) => {
          sinkRequest = {
            authorization: new Headers(init?.headers).get('authorization') ?? undefined,
            body: JSON.parse(String(init?.body)) as SlackInteractionSinkEnvelope
          }
          return Response.json(
            { data: { chat_object_id: '00000000-0000-4000-8000-000000000123' } },
            { status: 202 }
          )
        }
      }
      expect(await sendSlackInteractionSnapshot(options, currentMessage())).toEqual({
        chatObjectId: '00000000-0000-4000-8000-000000000123',
        outcome: 'sent'
      })
      expect(sinkRequest.authorization).toBe(`Bearer ${'i'.repeat(32)}`)
      expect(sinkRequest.body?.messages).toHaveLength(2)
      expect(sinkRequest.body?.interaction_finished).toBe(true)
      expect(sinkRequest.body?.agent_usage).toEqual([])
    } finally {
      slack.stop(true)
    }
  })

  test('caches profiles for six-hour-style TTLs and retains stale data on failure', async () => {
    let profileCalls = 0
    let failProfiles = false
    const slack = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/api/users.info') {
          profileCalls += 1
          if (failProfiles) return Response.json({ ok: false }, { status: 503 })
          const user = url.searchParams.get('user')!
          return Response.json({
            ok: true,
            user: {
              id: user,
              profile: {
                display_name: user === 'UHUMAN' ? 'Slack Brad' : 'Slack Bot',
                image_192: `https://avatar.test/${user}.png`
              }
            }
          })
        }
        return Response.json({
          ok: true,
          messages: [
            { text: '<@UAGENT> finished', ts: '1780000001.000100', user: 'UHUMAN' },
            {
              bot_id: 'BAGENT',
              bot_profile: { name: 'Old Bot', user_id: 'UAGENT' },
              text: 'Recorded.',
              ts: '1780000002.000100'
            }
          ],
          response_metadata: { next_cursor: '' }
        })
      }
    })
    const bodies: SlackInteractionSinkEnvelope[] = []
    try {
      const options: SlackbotV2Options = {
        apiUrl: 'http://session.test',
        botToken: 'xoxb-test',
        botUserId: 'UAGENT',
        signingSecret: 'test-signing-secret',
        slackApiUrl: `http://127.0.0.1:${slack.port}/api/`,
        interactionSink: {
          url: 'http://context.test/ingest',
          token: 'i'.repeat(32),
          profileTtlMs: 2,
          botIdentity: {
            displayName: 'Ed (enyu editor)',
            avatarAsset: { sha256: 'a'.repeat(64), filename: 'ed.png' }
          },
          identityOverrides: {
            UHUMAN: {
              displayName: 'Brad',
              avatarAsset: { sha256: 'b'.repeat(64), filename: 'brad.jpg' }
            }
          }
        },
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as SlackInteractionSinkEnvelope)
          return Response.json(
            { data: { chat_object_id: '00000000-0000-4000-8000-000000000123' } },
            { status: 202 }
          )
        }
      }
      await sendSlackInteractionSnapshot(options, currentMessage())
      expect(profileCalls).toBe(2)
      await sendSlackInteractionSnapshot(options, currentMessage())
      expect(profileCalls).toBe(2)
      await Bun.sleep(5)
      failProfiles = true
      await sendSlackInteractionSnapshot(options, currentMessage())
      expect(profileCalls).toBe(4)
      await sendSlackInteractionSnapshot(options, currentMessage())
      expect(profileCalls).toBe(6)

      const latest = bodies.at(-1)!
      const human = latest.messages.find(message => message.sender.provider_user_id === 'UHUMAN')!
      const bot = latest.messages.find(message => message.sender.provider_user_id === 'UAGENT')!
      expect(human.sender).toMatchObject({
        display_name: 'Brad',
        avatar_url: 'https://avatar.test/UHUMAN.png',
        avatar_asset: { sha256: 'b'.repeat(64), filename: 'brad.jpg' }
      })
      expect(bot.sender).toMatchObject({
        display_name: 'Ed (enyu editor)',
        avatar_url: 'https://avatar.test/UAGENT.png',
        avatar_asset: { sha256: 'a'.repeat(64), filename: 'ed.png' }
      })
    } finally {
      slack.stop(true)
    }
  })

  test('forces a pre-turn snapshot open and rejects an invalid chat identity', async () => {
    const slack = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        ok: true,
        messages: [{ text: '<@UAGENT> done', ts: '1780000001.000100', user: 'UHUMAN' }],
        response_metadata: { next_cursor: '' }
      })
    })
    let interactionFinished: boolean | undefined
    try {
      const options: SlackbotV2Options = {
        apiUrl: 'http://session.test',
        botToken: 'xoxb-test',
        signingSecret: 'test-signing-secret',
        slackApiUrl: `http://127.0.0.1:${slack.port}/api/`,
        interactionSink: { url: 'http://context.test/ingest', token: 'i'.repeat(32) },
        fetch: async (_input, init) => {
          interactionFinished = (JSON.parse(String(init?.body)) as SlackInteractionSinkEnvelope)
            .interaction_finished
          return Response.json({ data: { chat_object_id: 'not-a-uuid' } }, { status: 202 })
        }
      }
      await expect(
        sendSlackInteractionSnapshot(options, currentMessage(), [], {
          interactionFinished: false
        })
      ).rejects.toThrow('invalid chat_object_id')
      expect(interactionFinished).toBe(false)
    } finally {
      slack.stop(true)
    }
  })
})
