import type { JsonObject, JsonValue, SlackbotV2RendererSource, SlackbotV2Trace } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_AFFECTED_OBJECTS = 100
const MAX_TRACE_STRING_CHARS = 16_000
const MAX_TRACE_ENTRY_BYTES = 220 * 1024
const MAX_TRACE_TOTAL_BYTES = 768 * 1024
const SENSITIVE_KEY = /^(authorization|cookie|credentials?|passwords?|secrets?|tokens?|api[_-]?(?:keys?|tokens?)|private[_-]?keys?|(?:access|refresh|auth|bearer|session|id|secret)[_-]?tokens?)$/i

export class InteractionRunTraceCollector {
  readonly #trace: SlackbotV2Trace
  readonly #affectedObjectIds = new Set<string>()
  readonly #consultedObjectIds = new Set<string>()
  readonly #toolStartedAt = new Map<string, number>()

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
    if (method === 'centaur/inputSnapshot') {
      appendRunTrace(this.#trace, {
        id: `${this.#trace.messageId}:instructions`,
        entry_type: 'instruction_snapshot',
        name: 'agent instructions',
        status: 'completed',
        component: 'sandbox',
        facts: sanitizeTraceValue(raw.params) as JsonObject
      })
      return
    }
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
    if (!completed) this.#toolStartedAt.set(itemId, globalThis.performance?.now?.() ?? Date.now())
    const startedAt = this.#toolStartedAt.get(itemId)
    appendRunTrace(this.#trace, {
      id: `${this.#trace.messageId}:tool:${itemId}`,
      entry_type: 'tool_call',
      name: toolName(item),
      status: completed ? toolStatus(item) : 'running',
      component: 'centaur_agent',
      ...(completed && startedAt !== undefined
        ? { duration_ms: Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt)) }
        : {}),
      facts: {
        description: completed ? 'Tool call completed.' : 'Tool call started.',
        item_type: text(item.type) ?? 'tool_call',
        ...(text(item.server) ? { server: text(item.server) } : {}),
        ...(text(item.errorType) ? { error_class: text(item.errorType) } : {}),
        ...safeToolFacts(item)
      }
    })
    if (completed && isMutatingTool(item)) collectObjectIds(item, this.#affectedObjectIds)
    if (completed && isContextTool(item) && !isMutatingTool(item)) {
      collectObjectIds(item, this.#consultedObjectIds)
      collectCommandObjectIds(item, this.#consultedObjectIds)
      this.#trace.consultedObjectIds = [
        ...new Set([
          ...(this.#trace.consultedObjectIds ?? []),
          ...this.#consultedObjectIds
        ])
      ].slice(0, MAX_AFFECTED_OBJECTS)
    }
    if (completed) this.#toolStartedAt.delete(itemId)
  }

  affectedObjectIds(): string[] {
    return [...this.#affectedObjectIds].slice(0, MAX_AFFECTED_OBJECTS)
  }
}

function safeToolFacts(item: JsonObject): JsonObject {
  const facts: JsonObject = {}
  for (const key of ['arguments', 'command', 'error', 'output', 'aggregatedOutput', 'result']) {
    if (item[key] !== undefined) facts[normalizedToolField(key)] = sanitizeTraceValue(item[key])
  }
  return facts
}

function normalizedToolField(key: string): string {
  return key === 'aggregatedOutput' ? 'output' : key
}

function sanitizeTraceValue(value: unknown, key = ''): JsonValue {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    const safeText = redactSensitiveText(value)
    const looksBase64 = safeText.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(safeText)
    if (looksBase64) return `[base64 omitted: ${safeText.length} chars]`
    if (safeText.length > MAX_TRACE_STRING_CHARS) {
      return `${safeText.slice(0, MAX_TRACE_STRING_CHARS)}\n…[truncated ${safeText.length - MAX_TRACE_STRING_CHARS} chars]`
    }
    return safeText
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeTraceValue(item, key))
  const record = asRecord(value)
  if (!record) return String(value)
  const result: JsonObject = {}
  for (const [childKey, child] of Object.entries(record).slice(0, 100)) {
    result[childKey] = sanitizeTraceValue(child, childKey)
  }
  return result
}

export function appendRunTrace(trace: SlackbotV2Trace, entry: JsonObject): void {
  const id = text(entry.id)
  if (!id) return
  const entries = trace.runEntries ??= []
  const index = entries.findIndex(candidate => candidate.id === id)
  let value: JsonObject = { ...entry, created_at: entry.created_at ?? new Date().toISOString() }
  if (index >= 0 && entry.created_at === undefined) value.created_at = entries[index]?.created_at ?? value.created_at
  const priorBytes = index >= 0 ? jsonBytes(entries[index]) : 0
  const otherBytes = entries.reduce((total, candidate) => total + jsonBytes(candidate), 0) - priorBytes
  if (jsonBytes(value) > MAX_TRACE_ENTRY_BYTES || otherBytes + jsonBytes(value) > MAX_TRACE_TOTAL_BYTES) {
    value = {
      id,
      entry_type: entry.entry_type,
      name: entry.name,
      status: entry.status,
      component: entry.component,
      created_at: value.created_at,
      facts: {
        description: 'Trace details were omitted to keep the Run evidence within its storage limit.',
        truncated: true
      }
    }
  }
  if (index >= 0) entries[index] = value
  else entries.push(value)
}

function jsonBytes(value: JsonObject | undefined): number {
  return value ? new TextEncoder().encode(JSON.stringify(value)).byteLength : 0
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
  const contextCommand = command?.match(/\bcentaur-context\s+([a-z][a-z0-9-]*)(?:\s|$)/i)
  if (contextCommand?.[1]) return `centaur-context ${contextCommand[1]}`
  return text(item.name) ?? text(item.tool) ?? text(item.type) ?? 'tool call'
}

function isMutatingTool(item: JsonObject): boolean {
  const command = text(item.command)
  const contextCommand = command?.match(/\bcentaur-context\s+([a-z][a-z0-9-]*)(?:\s|$)/i)?.[1]
  if (contextCommand) {
    return /^(create|update|delete|commit|link|unlink|attach|detach|ingest|enqueue)-/.test(contextCommand)
      || ['commit-source-intake', 'enqueue-source-intake'].includes(contextCommand)
  }
  const name = (text(item.name) ?? text(item.tool) ?? '').replaceAll('_', '-').toLowerCase()
  return /^(create|update|delete|commit|link|unlink|attach|detach|ingest|enqueue)-/.test(name)
}

function isContextTool(item: JsonObject): boolean {
  const command = text(item.command)
  if (command?.match(/\bcentaur-context\s+[a-z][a-z0-9-]*(?:\s|$)/i)) return true
  const name = (text(item.name) ?? text(item.tool) ?? '').replaceAll('_', '-').toLowerCase()
  return name.startsWith('centaur-context-')
}

function collectCommandObjectIds(item: JsonObject, ids: Set<string>): void {
  const command = text(item.command)
  if (!command) return
  for (const match of command.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)) {
    ids.add(match[0])
    if (ids.size >= MAX_AFFECTED_OBJECTS) return
  }
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

function redactSensitiveText(value: string): string {
  return value
    .replace(/(--(?:token|api[_-]?key|password|secret)(?:=|\s+))["']?[^\s"']+["']?/gi, '$1[REDACTED]')
    .replace(/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)\s*=\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(["'](?:token|api[_-]?key|password|secret|authorization)["']\s*:\s*["'])[^"']+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
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
