import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createMemoryState } from '@chat-adapter/state-memory'
import { TaskDispatcher, taskProject, validateDispatchTask, verifyDispatchSignature, type TaskDispatchConfig } from '../src/task-dispatch'

const taskId = '11111111-1111-4111-8111-111111111111'
const config: TaskDispatchConfig = {
  secret: 'test-capability', contextUrl: 'http://context.test', contextToken: 'test-context-token', ownerIds: ['owner'],
  userId: 'UOWNER', teamId: 'TTEAM', instanceId: 'agent', model: 'test-model', reasoning: 'high',
  projects: { research: { channel: 'CRESEARCH', persona: 'research' }, dev: { channel: 'CDEV', persona: 'dev' } }, originChannels: ['CGENERAL']
}
function task(fields = {}) { return {
  object: { id: taskId, revision: 1, title: 'Summarise evidence' },
  subtype: { status: 'todo', agent_suitable: true, owner_object_id: 'owner', due_at: '2026-09-24', brief_markdown: 'Project: research\n\nSummarise the supplied evidence; cite sources.', ...fields }, connections: []
} }
function request() { return JSON.stringify({ task_id: taskId, origin_thread: 'slack:TTEAM:bot-agent:CGENERAL:123.456', requested_at: Date.now() }) }
function sign(raw: string) { return `sha256=${createHmac('sha256', config.secret).update(raw).digest('hex')}` }
async function fixture() {
  const state = createMemoryState(); await state.connect()
  const posts: Array<Record<string, any>> = []; const starts: string[] = []
  let canonical = task(), uncertainPost = false, failedHandoff = false, complete = false
  const ports = {
    fetch: (async (_url: any, init: any) => {
      expect(init.headers['X-Centaur-Principal-Id']).toBe('task-dispatch-agent')
      expect(init.headers['X-Centaur-Thread-Key']).toBe('service:task-dispatch:agent')
      return Response.json({ data: { objects: [canonical] } })
    }) as unknown as typeof fetch,
    slack: async (method: string, body: Record<string, any>) => {
      if (method.startsWith('conversations.')) return { ok: true, messages: posts.filter(p => p.channel === body.channel && p.thread_ts === body.ts) }
      const posted = { ...body, ts: `${1000 + posts.length}.123456` }; posts.push(posted)
      if (uncertainPost) { uncertainPost = false; throw new Error('response lost after Slack committed') }
      return { ok: true, ts: posted.ts }
    },
    start: async (record: { id: string }) => { if (failedHandoff) { failedHandoff = false; throw new Error('API unavailable') }; if (!starts.includes(record.id)) starts.push(record.id) },
    finished: async () => complete
  }
  const dispatcher = new TaskDispatcher(config, state, ports)
  return { dispatcher, state, ports, posts, starts, setTask: (fields: Record<string, unknown>) => { canonical = task(fields) },
    losePostResponse: () => { uncertainPost = true }, failHandoff: () => { failedHandoff = true }, finish: () => { complete = true } }
}

describe('task dispatch', () => {
  test('authenticates the exact body and rejects expired/out-of-scope requests', async () => {
    const f = await fixture(), raw = request()
    expect(verifyDispatchSignature(raw, sign(raw), config.secret)).toBe(true)
    expect(verifyDispatchSignature(raw + ' ', sign(raw), config.secret)).toBe(false)
    await expect(f.dispatcher.request(raw, 'invalid')).rejects.toThrow('authentication')
    const expired = JSON.stringify({ ...JSON.parse(raw), requested_at: 1 })
    await expect(f.dispatcher.request(expired, sign(expired))).rejects.toThrow('expired')
    const wrong = JSON.stringify({ ...JSON.parse(raw), origin_thread: 'slack:TTEAM:bot-other:CGENERAL:123.456' })
    await expect(f.dispatcher.request(wrong, sign(wrong))).rejects.toThrow('Origin')
    expect(f.posts).toHaveLength(0)
  })
  test('validates project and task execution requirements', () => {
    expect(taskProject('Project: research\n')).toBe('research')
    expect(() => taskProject('Project: research\nProject: dev')).toThrow('exactly one')
    for (const fields of [{ execution_actor_id: 'another-actor' }, { status: 'doing' }, { status: 'done' }, { agent_suitable: false }, { owner_object_id: 'other' }, { due_at: null }, { brief_markdown: 'Project: general' }, { brief_markdown: 'Project: dev' }]) {
      expect(() => validateDispatchTask(task(fields), config)).toThrow()
    }
    expect(validateDispatchTask(task(), config).project).toBe('research')
  })
  test('duplicate requests share one root and one handoff', async () => {
    const f = await fixture(), raw = request()
    const first = await f.dispatcher.request(raw, sign(raw))
    const second = await f.dispatcher.request(raw, sign(raw))
    expect(second.id).toBe(first.id); expect(first.targetChannel).toBe('CRESEARCH')
    expect(first.handedOff).toBe(true); expect(f.posts).toHaveLength(1); expect(f.starts).toHaveLength(1)
  })
  test('recovers uncertain Slack root post by metadata after a service restart', async () => {
    const f = await fixture(), raw = request(); f.losePostResponse()
    await expect(f.dispatcher.request(raw, sign(raw))).rejects.toThrow('response lost')
    const restarted = new TaskDispatcher(config, f.state, f.ports)
    await restarted.recover()
    expect(f.posts).toHaveLength(1); expect(f.starts).toHaveLength(1)
  })
  test('retries a failed handoff without creating another root', async () => {
    const f = await fixture(), raw = request(); f.failHandoff()
    await expect(f.dispatcher.request(raw, sign(raw))).rejects.toThrow('API unavailable')
    await f.dispatcher.recover()
    expect(f.posts).toHaveLength(1); expect(f.starts).toHaveLength(1)
  })
  test('repairs a missing active pointer instead of dispatching twice', async () => {
    const f = await fixture(), raw = request()
    await f.dispatcher.request(raw, sign(raw))
    await f.state.delete(`task-dispatch:active:${taskId}`)
    const other = JSON.stringify({ ...JSON.parse(raw), origin_thread: 'slack:TTEAM:bot-agent:CGENERAL:456.789' })
    await f.dispatcher.request(other, sign(other))
    expect(f.posts).toHaveLength(1); expect(f.starts).toHaveLength(1)
  })
  test('concurrent recovery delivers a single terminal notice', async () => {
    const f = await fixture(), raw = request()
    await f.dispatcher.request(raw, sign(raw)); f.finish(); f.setTask({ status: 'done' })
    const second = new TaskDispatcher(config, f.state, f.ports)
    await Promise.all([f.dispatcher.recover(), second.recover()])
    expect(f.posts).toHaveLength(2); expect(f.starts).toHaveLength(1)
  })
  test('does not begin execution when task is cancelled during an uncertain post', async () => {
    const f = await fixture(), raw = request(); f.losePostResponse()
    await expect(f.dispatcher.request(raw, sign(raw))).rejects.toThrow()
    f.setTask({ status: 'cancelled' })
    await f.dispatcher.recover()
    expect(f.posts).toHaveLength(1); expect(f.starts).toHaveLength(0)
  })
  test('terminal notification recovery never reruns execution or duplicates a committed notice', async () => {
    const f = await fixture(), raw = request()
    await f.dispatcher.request(raw, sign(raw)); f.finish(); f.setTask({ status: 'done' }); f.losePostResponse()
    await f.dispatcher.recover(); await f.dispatcher.recover(); await f.dispatcher.recover()
    expect(f.posts).toHaveLength(2); expect(f.starts).toHaveLength(1)
    expect(f.posts[1]?.thread_ts).toBe('123.456'); expect(f.posts[1]?.text).toContain('complete')
  })
})

describe('Routine occurrence dispatch', () => {
  async function routineFixture() {
    const state = createMemoryState(); await state.connect()
    const posts: any[] = [], starts: any[] = []
    let run: any = { id: '22222222-2222-4222-8222-222222222222', task_id: taskId, definition_revision: 1, status: 'pending', eligible: true }
    let canonical = task(), finished = false, lostPost = false
    const ports = {
      fetch: (async (url: any, init: any) => {
        if (String(url).endsWith('/api/v2/read')) return Response.json({ data: { objects: [canonical] } })
        expect(init.headers.Authorization).toBe('Bearer trusted-routine-token')
        if (String(url).endsWith('/routines/claim')) return Response.json({data: ['pending','running'].includes(run.status) ? [run] : []})
        if (init.method === 'GET') return Response.json({data:run})
        const patch = JSON.parse(init.body)
        if (patch.status === 'running' && !run.eligible) return Response.json({error:'paused'}, {status:400})
        if (['pending','running'].includes(run.status)) run = { ...run, ...patch }
        return Response.json({data:run})
      }) as typeof fetch,
      slack: async (method: string, body: any) => {
        if (method.startsWith('conversations.')) return {messages: posts}
        const posted={...body,ts:'123.456'}; posts.push(posted)
        if(lostPost){lostPost=false;run.eligible=false;throw new Error('lost response')}
        return posted
      },
      start: async (record: any) => {if(!starts.some(s=>s.id===record.id))starts.push(record)},
      finished: async () => finished
    }
    const cfg = {...config,routineIngestUrl:'http://ingest.test',routineIngestToken:'trusted-routine-token'}
    const dispatcher=new TaskDispatcher(cfg,state,ports)
    return {dispatcher,posts,starts,state,ports,cfg,run:()=>run,pause:()=>{run.eligible=false},losePost:()=>{lostPost=true},finish:()=>{finished=true},result:()=>{run.status='completed'},ownerOutside:()=>{canonical=task({owner_object_id:'someone-else'})}}
  }
  test('uses one fresh project thread across duplicate polls and restart; preserves explicit result', async () => {
    const f=await routineFixture()
    await Promise.all([f.dispatcher.recover(),f.dispatcher.recover()])
    await new TaskDispatcher(f.cfg,f.state,f.ports).recover()
    expect(f.posts).toHaveLength(1);expect(f.starts).toHaveLength(1)
    expect(f.starts[0].project).toBe('research');expect(f.starts[0].routineRunId).toBe(f.run().id)
    expect(f.run().execution_thread).toBe('slack:TTEAM:bot-agent:CRESEARCH:123.456')
    f.result();f.finish();await f.dispatcher.recover()
    expect(f.run().status).toBe('completed');expect(f.posts).toHaveLength(1)
  })
  test('defaults returned execution to Review without completing parent', async () => {
    const f=await routineFixture();await f.dispatcher.recover();f.finish();await f.dispatcher.recover()
    expect(f.run().status).toBe('review');expect(f.starts).toHaveLength(1)
  })
  test('reconciles uncertain posting and honours pause before handoff', async () => {
    const f=await routineFixture();f.losePost();await f.dispatcher.recover();f.pause();await f.dispatcher.recover()
    expect(f.posts).toHaveLength(1);expect(f.starts).toHaveLength(0);expect(f.run().status).toBe('skipped')
  })
  test('rejects a Routine outside the configured ownership boundary', async () => {
    const f=await routineFixture();f.ownerOutside();await f.dispatcher.recover()
    expect(f.posts).toHaveLength(0);expect(f.starts).toHaveLength(0);expect(f.run().status).toBe('blocked')
  })
})
