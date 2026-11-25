import type { ConflictRecord, EntityKind } from './domain'
import { localDb, markChangeSynced, pendingChanges, pendingConflicts, recordConflict, applyServerRecord } from './localDb'

interface PushResult {
  accepted: { operationId: string; version: number }[]
  conflicts: {
    operationId: string
    kind: EntityKind
    recordId: string
    localPayload: unknown | null
    serverPayload: unknown | null
    serverVersion: number
  }[]
}

interface PullResult {
  cursor: string
  changes: {
    kind: EntityKind
    recordId: string
    payload: unknown | null
    version: number
    deleted: boolean
  }[]
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'include' })
  if (!response.ok) throw new Error(`Sync failed (${response.status})`)
  return response.json() as Promise<T>
}

export async function syncNow() {
  const [allPending, unresolved] = await Promise.all([pendingChanges(), pendingConflicts()])
  const blocked = new Set(unresolved.map((conflict) => `${conflict.kind}:${conflict.recordId}`))
  const outgoing = allPending.filter((change) => !blocked.has(`${change.kind}:${change.recordId}`))
  let conflictCount = 0
  if (outgoing.length) {
    const pushed = await request<PushResult>('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: outgoing }),
    })
    for (const result of pushed.accepted) await markChangeSynced(result.operationId, result.version)
    for (const result of pushed.conflicts) {
      const local = outgoing.find((change) => change.operationId === result.operationId)
      const conflict: ConflictRecord = {
        id: crypto.randomUUID(),
        kind: result.kind,
        recordId: result.recordId,
        localPayload: result.localPayload ?? local?.payload ?? null,
        serverPayload: result.serverPayload,
        serverVersion: result.serverVersion,
        detectedAt: new Date().toISOString(),
      }
      await recordConflict(conflict)
      conflictCount += 1
    }
  }

  const cursor = (await localDb.settings.get('syncCursor'))?.value ?? '0'
  const pulled = await request<PullResult>(`/api/sync/pull?cursor=${encodeURIComponent(cursor)}`)
  for (const change of pulled.changes) {
    await applyServerRecord(change.kind, change.recordId, change.deleted ? null : change.payload, change.version)
  }
  await localDb.settings.put({ key: 'syncCursor', value: pulled.cursor })
  return { conflictCount, pendingCount: (await pendingChanges()).length }
}