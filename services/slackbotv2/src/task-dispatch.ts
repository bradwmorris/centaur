import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { StateAdapter } from 'chat'

export type ProjectRoute = { channel: string; persona: string }
export type TaskDispatchConfig = {
  secret: string
  contextUrl: string
  contextToken: string
  routineIngestUrl?: string
  routineIngestToken?: string
  ownerIds: string[]
  userId: string
  teamId: string
  instanceId: string
  model: string
  reasoning: string
  projects: Record<string, ProjectRoute>
  originChannels: string[]
}
export type DispatchRecord = {
  routineRunId?: string
  id: string; taskId: string; revision: number; title: string; brief: string
  project: string; originChannel: string; originTs: string; targetChannel: string
  handoffAttempted?: boolean; postAttempted?: boolean; noticeAttempted?: boolean; targetTs?: string; url?: string; handedOff?: boolean; notified?: boolean; createdAt: number
}
type TaskRecord = { object: { id: string; revision: number; title: string; archived_at?: string | null }; subtype: Record<string, unknown>; connections?: Array<{ kind: string; source_object_id: string; target_object_id: string; archived_at?: string | null }> }
export type DispatchPorts = {
  slack(method: string, body: Record<string, unknown>): Promise<Record<string, any>>
  start(record: DispatchRecord): Promise<void>
  finished(record: DispatchRecord): Promise<boolean>
  fetch?: typeof fetch
}
const TTL = 90 * 24 * 60 * 60 * 1000
const INDEX = 'task-dispatch:index'
const key = (id: string) => `task-dispatch:record:${id}`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function verifyDispatchSignature(raw: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}
export function taskProject(brief: string): string {
  const matches = [...brief.matchAll(/^Project:\s*([a-z]+)\s*$/gm)]
  if (matches.length !== 1) throw new Error('Task brief must contain exactly one Project: <project> line.')
  return matches[0]![1]!
}
export function validateDispatchTask(task: TaskRecord, config: TaskDispatchConfig): { project: string; brief: string } {
  const f = task.subtype
  if (task.object.archived_at || f.execution_actor_id || !['todo', 'review'].includes(String(f.status))) throw new Error('Task is not available for a new execution; inspect its status or current claim.')
  if (!config.ownerIds.includes(String(f.owner_object_id))) throw new Error('Task owner is outside this dispatch capability.')
  if (f.agent_suitable !== true) throw new Error('Task is not marked suitable for agent execution.')
  if (!f.due_at || !Number.isFinite(Date.parse(String(f.due_at)))) throw new Error('Task needs an agreed due date.')
  const brief = typeof f.brief_markdown === 'string' ? f.brief_markdown.trim() : ''
  if (!brief || brief.length > 40000) throw new Error('Task needs a bounded execution brief.')
  const project = taskProject(brief)
  if (project === 'general' || !config.projects[project]) throw new Error('Task does not name an executable configured project.')
  if ((f.work_kind === 'code' || project === 'dev') && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9][0-9]*$/.test(String(f.github_issue_url))) throw new Error('Development execution requires a canonical GitHub Issue.')
  return { project, brief }
}

/** Durable dispatch receipts use the same Postgres-backed state store as Slack rendering. */
export class TaskDispatcher {
  constructor(private config: TaskDispatchConfig, private state: StateAdapter, private ports: DispatchPorts) {}

  async readTask(taskId: string): Promise<TaskRecord> {
    const response = await (this.ports.fetch ?? fetch)(`${this.config.contextUrl.replace(/\/$/, '')}/api/v2/read`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${this.config.contextToken}`, 'Content-Type': 'application/json',
        // Read as this service, never impersonate the planning or execution actor.
        'X-Centaur-Principal-Id': `task-dispatch-${this.config.instanceId}`,
        'X-Centaur-Thread-Key': `service:task-dispatch:${this.config.instanceId}`
      },
      body: JSON.stringify({ object_ids: [taskId], include: ['connections'] }), signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) throw new Error(`Context read failed (${response.status}).`)
    const body = await response.json() as { data?: { objects?: TaskRecord[] } }
    const task = body.data?.objects?.find(item => item.object.id === taskId)
    if (!task) throw new Error('Canonical task was not returned by Context.')
    return task
  }

  private async routineApi(path: string, method: string, body?: unknown): Promise<any> {
    if (!this.config.routineIngestUrl || !this.config.routineIngestToken) throw new Error('Routine execution is not configured.')
    const response = await (this.ports.fetch ?? fetch)(`${this.config.routineIngestUrl.replace(/\/$/, '')}/api/v2/ingest/${path}`, {
      method, headers: { Authorization: `Bearer ${this.config.routineIngestToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) throw new Error(`Routine request failed (${response.status}).`)
    return (await response.json() as { data: unknown }).data
  }

  private async pollRoutines(): Promise<void> {
    if (!this.config.routineIngestUrl) return
    const runs = await this.routineApi('routines/claim', 'POST') as Array<{ id: string; task_id: string; definition_revision: number; status: string }>
    for (const run of runs) {
      const mutex = `task-dispatch:lock:${run.task_id}`, lease = crypto.randomUUID()
      if (!await this.state.setIfNotExists(mutex, lease, 120000)) continue
      try {
        const id = createHash('sha256').update(`routine:${run.id}`).digest('hex')
        const existing = await this.state.get<DispatchRecord>(key(id))
        if (existing) { await this.resume(existing); continue }
        // A lost receipt for an already bound run is uncertain, never a new start.
        if (run.status !== 'pending') continue
        const activeId = await this.state.get<string>(`task-dispatch:active:${run.task_id}`)
        const active = activeId ? await this.state.get<DispatchRecord>(key(activeId)) : undefined
        if (active && !active.notified) continue
        const task = await this.readTask(run.task_id)
        let project: string, brief: string
        try {
          ;({ project, brief } = validateDispatchTask(task, this.config))
          if (task.object.revision !== run.definition_revision) throw new Error('Routine definition changed before execution.')
          for (const edge of task.connections ?? []) {
            if (!edge.archived_at && edge.kind === 'depends_on' && edge.source_object_id === run.task_id
              && (await this.readTask(edge.target_object_id)).subtype.status !== 'done') throw new Error('Routine has an unfinished dependency.')
          }
        } catch (error) {
          await this.routineApi(`routine-runs/${run.id}`, 'PATCH', { status: 'blocked', result: error instanceof Error ? error.message : 'Routine is not executable.' })
          continue
        }
        const targetChannel = this.config.projects[project]!.channel
        const record: DispatchRecord = { id, routineRunId: run.id, taskId: run.task_id, revision: task.object.revision,
          title: task.object.title, brief, project, targetChannel, originChannel: targetChannel, originTs: '', createdAt: Date.now() }
        await this.state.appendToList(INDEX,id,{maxLength:10000,ttlMs:TTL})
        await this.state.set(key(id),record,TTL)
        await this.state.set(`task-dispatch:active:${run.task_id}`,id,TTL)
        await this.resume(record)
      } catch {
        // Keep durable claims pending on transport failures; never issue a new run.
      } finally { if (await this.state.get(mutex) === lease) await this.state.delete(mutex) }
    }
  }

  async request(raw: string, signature?: string): Promise<DispatchRecord> {
    if (raw.length > 4096 || !verifyDispatchSignature(raw, signature, this.config.secret)) throw new Error('Invalid dispatch authentication.')
    const input = JSON.parse(raw) as { task_id?: string; origin_thread?: string; requested_at?: number }
    if (!input.task_id || !uuid.test(input.task_id) || !input.requested_at || Math.abs(Date.now() - input.requested_at) > 300000) throw new Error('Invalid or expired dispatch request.')
    const parts = String(input.origin_thread).split(':')
    if (parts.length !== 5 || parts[0] !== 'slack' || parts[1] !== this.config.teamId || parts[2] !== `bot-${this.config.instanceId}` || !/^\d+\.\d+$/.test(parts[4]!)) throw new Error('Origin must be a current configured Slack conversation.')
    const originChannel = parts[3]!, originTs = parts[4]!
    if (!this.config.originChannels.includes(originChannel)) {
      if (!/^D[A-Z0-9]+$/.test(originChannel)) throw new Error('Origin channel is not configured.')
      const info = await this.ports.slack('conversations.info', { channel: originChannel })
      if (info.channel?.is_im !== true || info.channel?.user !== this.config.userId) throw new Error('Origin DM does not belong to the configured owner.')
    }
    // Capability is intentionally scoped to this owner and these channels; the
    // sandbox cannot choose another user, model, principal, prompt or destination.
    const mutex = `task-dispatch:lock:${input.task_id}`
    const lease = crypto.randomUUID()
    if (!(await this.state.setIfNotExists(mutex, lease, 120000))) throw new Error('Dispatch already in progress; retry this request shortly.')
    try {
      let activeId = await this.state.get<string>(`task-dispatch:active:${input.task_id}`)
      // Repair a crash between writing the receipt and its active pointer.
      if (!activeId) {
        for (const pendingId of new Set(await this.state.getList<string>(INDEX))) {
          const pending = await this.state.get<DispatchRecord>(key(pendingId))
          if (pending?.taskId === input.task_id && !pending.notified) {
            activeId = pending.id
            await this.state.set(`task-dispatch:active:${input.task_id}`, activeId, TTL)
            break
          }
        }
      }
      if (activeId) {
        const active = await this.state.get<DispatchRecord>(key(activeId))
        if (active) {
          if (active.routineRunId && !active.notified) throw new Error('A Routine occurrence is already executing.')
          const task = await this.readTask(input.task_id)
          if (['done', 'blocked'].includes(String(task.subtype.status))) throw new Error('Task is complete or blocked; review it before requesting another execution.')
          if (!active.notified || task.subtype.status === 'doing') return await this.resume(active)
        }
      }
      const task = await this.readTask(input.task_id)
      const { project, brief } = validateDispatchTask(task, this.config)
      for (const edge of task.connections ?? []) {
        if (!edge.archived_at && edge.kind === 'depends_on' && edge.source_object_id === input.task_id) {
          if ((await this.readTask(edge.target_object_id)).subtype.status !== 'done') throw new Error('Task has an unfinished dependency.')
        }
      }
      const id = createHash('sha256').update(`${input.task_id}:${task.object.revision}:${originChannel}:${originTs}`).digest('hex')
      const previous = await this.state.get<DispatchRecord>(key(id))
      if (previous) return await this.resume(previous)
      const record: DispatchRecord = { id, taskId: input.task_id, revision: task.object.revision, title: task.object.title, brief,
        project, originChannel, originTs, targetChannel: this.config.projects[project]!.channel, createdAt: Date.now() }
      // Index first: a crash before the receipt write leaves a harmless absent entry.
      await this.state.appendToList(INDEX, id, { maxLength: 10000, ttlMs: TTL })
      await this.state.set(key(id), record, TTL)
      await this.state.set(`task-dispatch:active:${input.task_id}`, id, TTL)
      return await this.resume(record)
    } finally {
      if (await this.state.get(mutex) === lease) await this.state.delete(mutex)
    }
  }

  async resume(record: DispatchRecord): Promise<DispatchRecord> {
    // Each pending dispatch has an independent recovery lease in addition to
    // request serialization. Recovery and a client retry must not both post.
    const leaseKey = `task-dispatch:resume:${record.id}`
    const lease = crypto.randomUUID()
    if (!await this.state.setIfNotExists(leaseKey, lease, 120000)) return record
    try {
      record = await this.state.get<DispatchRecord>(key(record.id)) ?? record
      if (record.routineRunId && !record.handoffAttempted) {
        const occurrence = await this.routineApi(`routine-runs/${record.routineRunId}`, 'GET')
        if (['review','completed','blocked','skipped'].includes(occurrence.status) || !occurrence.eligible) {
          if (occurrence.status === 'pending') await this.routineApi(`routine-runs/${record.routineRunId}`, 'PATCH', { status:'skipped', result:'Routine paused or changed before execution.' })
          record.notified = true
          await this.state.set(key(record.id),record,TTL)
          return record
        }
      }
      if (!record.targetTs) {
        const recovered = await this.findMessage(record.targetChannel, record.id)
        if (!recovered && record.postAttempted) throw new Error('Slack post outcome is uncertain; awaiting reconciliation without posting a duplicate.')
        if (!recovered) { record.postAttempted = true; await this.state.set(key(record.id), record, TTL) }
        const posted = recovered ?? await this.ports.slack('chat.postMessage', {
          channel: record.targetChannel, text: `Execute task: ${record.title}`,
          metadata: { event_type: 'centaur_task_dispatch', event_payload: { dispatch_id: record.id, task_id: record.taskId } },
          client_msg_id: `${record.id.slice(0,8)}-${record.id.slice(8,12)}-4${record.id.slice(13,16)}-8${record.id.slice(17,20)}-${record.id.slice(20,32)}`
        })
        if (typeof posted.ts !== 'string') throw new Error('Slack did not return the execution thread identity.')
        record.targetTs = posted.ts
        record.url = `https://app.slack.com/archives/${record.targetChannel}/p${posted.ts.replace('.', '')}`
        await this.state.set(key(record.id), record, TTL)
      }
      if (!record.handedOff) {
        if (!record.handoffAttempted) {
          const current = await this.readTask(record.taskId)
          const validated = validateDispatchTask(current, this.config)
          if (current.object.revision !== record.revision || validated.project !== record.project) {
            throw new Error('Task changed after dispatch preparation; review before execution.')
          }
          if (record.routineRunId) {
            await this.routineApi(`routine-runs/${record.routineRunId}`, 'PATCH', {
              status: 'running', execution_thread: `slack:${this.config.teamId}:bot-${this.config.instanceId}:${record.targetChannel}:${record.targetTs}`,
              execution_url: record.url
            })
          }
          record.handoffAttempted = true
          await this.state.set(key(record.id), record, TTL)
        }
        await this.ports.start(record)
        record.handedOff = true
        await this.state.set(key(record.id), record, TTL)
      }
      return record
    } finally {
      if (await this.state.get(leaseKey) === lease) await this.state.delete(leaseKey)
    }
  }

  private async findMessage(channel: string, id: string, thread?: string): Promise<Record<string, any> | undefined> {
    let cursor: string | undefined
    // Bounded lookup must complete before posting again after an uncertain outcome.
    for (let page = 0; page < 50; page++) {
      const result = await this.ports.slack(thread ? 'conversations.replies' : 'conversations.history', {
        channel, ...(thread ? { ts: thread } : {}), limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {})
      })
      const found = result.messages?.find((message: any) => message.metadata?.event_type === 'centaur_task_dispatch' && message.metadata?.event_payload?.dispatch_id === id)
      if (found) return found
      cursor = result.response_metadata?.next_cursor
      if (!cursor) return undefined
    }
    throw new Error('Could not reconcile the complete Slack history; no duplicate was posted.')
  }

  async recover(): Promise<void> {
    try { await this.pollRoutines() } catch { /* Existing receipts still recover when Context polling is unavailable. */ }
    for (const id of new Set(await this.state.getList<string>(INDEX))) {
      const candidate = await this.state.get<DispatchRecord>(key(id))
      if (!candidate || candidate.notified) continue
      const mutex = `task-dispatch:lock:${candidate.taskId}`
      const lease = crypto.randomUUID()
      if (!await this.state.setIfNotExists(mutex, lease, 120000)) continue
      try {
        let record = await this.state.get<DispatchRecord>(key(id))
        if (!record || record.notified) continue
        if (!record.handedOff) record = await this.resume(record)
        if (!record.handedOff || !await this.ports.finished(record)) continue
        if (record.routineRunId) {
          await this.routineApi(`routine-runs/${record.routineRunId}`, 'PATCH', { status: 'review', result: 'Execution returned. Review the linked result.' })
          record.notified = true
          await this.state.set(key(id), record, TTL)
          continue
        }
        const task = await this.readTask(record.taskId)
        const status = String(task.subtype.status)
        const noticeId = `${id}:notice`
        const existing = await this.findMessage(record.originChannel, noticeId, record.originTs)
        if (!existing && record.noticeAttempted) continue
        if (!existing) {
          record.noticeAttempted = true
          await this.state.set(key(id), record, TTL)
          await this.ports.slack('chat.postMessage', {
          channel: record.originChannel, thread_ts: record.originTs,
          text: `${record.title}: ${status === 'done' ? 'complete' : status === 'blocked' ? 'blocked' : 'execution returned; review the result'}. ${record.url}`,
          metadata: { event_type: 'centaur_task_dispatch', event_payload: { dispatch_id: noticeId, task_id: record.taskId } }
        })
        }
        record.notified = true
        await this.state.set(key(id), record, TTL)
      } catch {
        // Keep the receipt pending; recovery retries without re-executing a
        // handed-off task. No task content or credentials are logged here.
      } finally {
        if (await this.state.get(mutex) === lease) await this.state.delete(mutex)
      }
    }
  }
}
