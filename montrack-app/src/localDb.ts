import Dexie, { type EntityTable } from 'dexie'
import type {
  ConflictRecord,
  EntityKind,
  PendingAttachment,
  PendingChange,
  StoredRecord,
} from './domain'
import { entityKey } from './domain'

class MonTrackDatabase extends Dexie {
  records!: EntityTable<StoredRecord, 'key'>
  outbox!: EntityTable<PendingChange, 'operationId'>
  conflicts!: EntityTable<ConflictRecord, 'id'>
  attachments!: EntityTable<PendingAttachment, 'id'>
  settings!: EntityTable<{ key: string; value: string }, 'key'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      records: '&key, kind, dirty, updatedAt',
      outbox: '&operationId, [kind+recordId], createdAt',
      conflicts: '&id, [kind+recordId], detectedAt',
      attachments: '&id, transactionId, createdAt',
      settings: '&key',
    })
  }
}

export const authDb = new MonTrackDatabase('montrack-auth')
export let localDb = new MonTrackDatabase('montrack-local-guest')

export function setActiveUser(userId: string) {
  localDb = new MonTrackDatabase(`montrack-user-${userId}`)
}

export async function saveRecord<T>(
  kind: EntityKind,
  id: string,
  payload: T,
  currentVersion = 0,
) {
  const key = entityKey(kind, id)
  const now = new Date().toISOString()
  await localDb.transaction('rw', localDb.records, localDb.outbox, async () => {
    const existing = await localDb.records.get(key)
    const pending = await localDb.outbox.where('[kind+recordId]').equals([kind, id]).first()
    const operation: PendingChange = {
      operationId: pending?.operationId ?? crypto.randomUUID(),
      kind,
      recordId: id,
      baseVersion: pending?.baseVersion ?? existing?.version ?? currentVersion,
      payload,
      deleted: false,
      createdAt: pending?.createdAt ?? now,
    }
    await localDb.records.put({ key, kind, id, payload, version: currentVersion, updatedAt: now, dirty: true })
    await localDb.outbox.put(operation)
  })
}

export async function deleteRecord(kind: EntityKind, id: string) {
  const key = entityKey(kind, id)
  const now = new Date().toISOString()
  await localDb.transaction('rw', localDb.records, localDb.outbox, async () => {
    const existing = await localDb.records.get(key)
    const pending = await localDb.outbox.where('[kind+recordId]').equals([kind, id]).first()
    await localDb.records.delete(key)
    await localDb.outbox.put({
      operationId: pending?.operationId ?? crypto.randomUUID(),
      kind,
      recordId: id,
      baseVersion: pending?.baseVersion ?? existing?.version ?? 0,
      payload: null,
      deleted: true,
      createdAt: pending?.createdAt ?? now,
    })
  })
}

export async function getRecords<T>(kind: EntityKind): Promise<StoredRecord<T>[]> {
  return localDb.records.where('kind').equals(kind).toArray() as Promise<StoredRecord<T>[]>
}

export async function pendingChanges() {
  return localDb.outbox.orderBy('createdAt').toArray()
}

export async function markChangeSynced(operationId: string, version: number) {
  await localDb.transaction('rw', localDb.records, localDb.outbox, async () => {
    const operation = await localDb.outbox.get(operationId)
    if (!operation) return
    const key = entityKey(operation.kind, operation.recordId)
    const record = await localDb.records.get(key)
    if (record) await localDb.records.put({ ...record, version, dirty: false })
    await localDb.outbox.delete(operationId)
  })
}

export async function removePendingChange(kind: EntityKind, id: string) {
  await localDb.outbox.where('[kind+recordId]').equals([kind, id]).delete()
}

export async function recordConflict(conflict: ConflictRecord) {
  await localDb.conflicts.put(conflict)
}

export async function pendingConflicts() {
  return localDb.conflicts.orderBy('detectedAt').toArray()
}

export async function resolveConflict(conflict: ConflictRecord, payload: unknown | null) {
  const key = entityKey(conflict.kind, conflict.recordId)
  const now = new Date().toISOString()
  await localDb.transaction('rw', localDb.records, localDb.outbox, localDb.conflicts, async () => {
    await localDb.outbox.where('[kind+recordId]').equals([conflict.kind, conflict.recordId]).delete()
    if (payload === null) {
      await localDb.records.delete(key)
      await localDb.outbox.put({
        operationId: crypto.randomUUID(), kind: conflict.kind, recordId: conflict.recordId,
        baseVersion: conflict.serverVersion, payload: null, deleted: true, createdAt: now,
      })
    } else {
      await localDb.records.put({
        key, kind: conflict.kind, id: conflict.recordId, payload,
        version: conflict.serverVersion, updatedAt: now, dirty: true,
      })
      await localDb.outbox.put({
        operationId: crypto.randomUUID(), kind: conflict.kind, recordId: conflict.recordId,
        baseVersion: conflict.serverVersion, payload, deleted: false, createdAt: now,
      })
    }
    await localDb.conflicts.delete(conflict.id)
  })
}

export async function applyServerRecord<T>(
  kind: EntityKind,
  id: string,
  payload: T | null,
  version: number,
) {
  const key = entityKey(kind, id)
  await localDb.transaction('rw', localDb.records, async () => {
    if (payload === null) await localDb.records.delete(key)
    else {
      const current = await localDb.records.get(key)
      if (!current?.dirty) {
        await localDb.records.put({
          key,
          kind,
          id,
          payload,
          version,
          updatedAt: new Date().toISOString(),
          dirty: false,
        })
      }
    }
  })
}