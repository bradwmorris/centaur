import type { JsonObject, SlackbotV2RendererSource, SlackbotV2Trace } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_AFFECTED_OBJECTS = 100

export class InteractionRunTraceCollector {
  readonly #trace: SlackbotV2Trace
  readonly #affectedObjectIds = new Set<string>()

  constructor(trace: SlackbotV2Trace) {
    this.#trace = trace
  }

  capture(source: SlackbotV2RendererSource): void {
    const payload = outputPayload(source)
    if (!payload) return
    const eventKind = text(payload.eventKind) ?? text(payload.event)
    if (eventKind === 'session.execution_failed' || eventKind === 'session.stream_error') {
      appendRunTrace(this.#trace, {
        id: `${this.#trace.messageId}:${eventKind}`,
        entry_type: 'execution',
        name: eventKind,
        status: 'failed',
        component: 'centaur_agent',
        facts: { description: 'The agent execution failed.' }
      })
    }

    const raw = eventKind === 'session.output.line' ? parseJson(payload.data) : payload
    if (!raw) return
    const method = text(raw.method)
    if (method === 'turn/failed') {
      appendRunTrace(this.#trace, {
        id: `${this.#trace.messageId}:turn-failed`,
        entry_type: 'model_attempt',
        name: 'model turn',
        status: 'failed',
        component: 'centaur_agent',
        facts: { description: 'The model turn failed.' }
      })
      return
    }
    if (method !== 'item/started' && method !== 'item/completed') return
    const params = asRecord(raw.params)
    const item = asRecord(params?.item)
    if (!item || !isToolItem(item)) return
    const itemId = text(item.id) ?? `${toolName(item)}:${this.#trace.runEntries?.length ?? 0}`
    const completed = method === 'item/completed'
    appendRunTrace(this.#trace, {
      id: `${this.#trace.messageId}:tool:${itemId}`,
      entry_type: 'tool_call',
      name: toolName(item),
      status: completed ? toolStatus(item) : 'running',
      component: 'centaur_agent',
      facts: {
        description: completed ? 'Tool call completed.' : 'Tool call started.',
        item_type: text(item.type) ?? 'tool_call',
        ...(text(item.server) ? { server: text(item.server) } : {})
      }
    })
    if (completed) collectObjectIds(item, this.#affectedObjectIds)
  }

  affectedObjectIds(): string[] {
    return [...this.#affectedObjectIds].slice(0, MAX_AFFECTED_OBJECTS)
  }
}

export function appendRunTrace(trace: SlackbotV2Trace, entry: JsonObject): void {
  const id = text(entry.id)
  if (!id) return
  const entries = trace.runEntries ??= []
  const index = entries.findIndex(candidate => candidate.id === id)
  const value = { ...entry, created_at: entry.created_at ?? new Date().toISOString() }
  if (index >= 0) entries[index] = value
  else entries.push(value)
}

export function finalizeRunTrace(
  trace: SlackbotV2Trace | undefined,
  status: 'completed' | 'failed'
): void {
  if (!trace?.runEntries) return
  const duration = Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - trace.startedAtMs))
  for (const entry of trace.runEntries) {
    if (entry.status === 'running') {
      entry.status = status
      entry.duration_ms ??= duration
    }
  }
}

function outputPayload(source: SlackbotV2RendererSource): JsonObject | undefined {
  return source && typeof source === 'object' && !Array.isArray(source)
    ? source as JsonObject
    : undefined
}

function parseJson(value: unknown): JsonObject | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  if (typeof value !== 'string') return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function isToolItem(item: JsonObject): boolean {
  const kind = text(item.type)?.replaceAll('_', '').toLowerCase() ?? ''
  return kind.includes('toolcall') || kind === 'commandexecution' || kind === 'functioncall'
}

function toolName(item: JsonObject): string {
  const command = text(item.command)
  const contextCommand = command?.match(/\bcentaur-context\s+(create-note|create-task)(?:\s|$)/)
  if (contextCommand?.[1]) return `centaur-context ${contextCommand[1]}`
  return text(item.name) ?? text(item.tool) ?? text(item.type) ?? 'tool call'
}

function toolStatus(item: JsonObject): string {
  const status = text(item.status)?.toLowerCase()
  return status === 'failed' || status === 'error' ? 'failed' : 'completed'
}

function collectObjectIds(value: unknown, ids: Set<string>, key = ''): void {
  if (ids.size >= MAX_AFFECTED_OBJECTS) return
  if (typeof value === 'string') {
    if ((key.endsWith('_id') || key.endsWith('_ids')) && UUID.test(value)) ids.add(value)
    if (key === 'aggregatedOutput' || key === 'output') {
      const parsed = parseCommandOutput(value)
      if (parsed) collectObjectIds(parsed, ids)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectObjectIds(item, ids, key)
    return
  }
  const record = asRecord(value)
  if (!record) return
  for (const [childKey, child] of Object.entries(record)) collectObjectIds(child, ids, childKey)
}

function parseCommandOutput(value: string): JsonObject | undefined {
  const trimmed = value.trim()
  const direct = parseJson(trimmed)
  if (direct) return direct
  for (let index = trimmed.lastIndexOf('\n{'); index >= 0; index = trimmed.lastIndexOf('\n{', index - 1)) {
    const parsed = parseJson(trimmed.slice(index + 1))
    if (parsed) return parsed
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}
