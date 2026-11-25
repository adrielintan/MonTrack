export type TransactionType = 'expense' | 'income' | 'transfer'
export type EntityKind = 'account' | 'adjustment' | 'category' | 'project' | 'tag' | 'transaction' | 'debt'

export interface Account {
  id: string
  name: string
  currency: string
  openingBalance: number
  openingAt: string
  color: string
  active: boolean
}

export interface BalanceAdjustment {
  id: string
  accountId: string
  occurredAt: string
  amount: number
  note: string
}

export interface Category {
  id: string
  name: string
  appliesTo: 'expense' | 'income'
  color: string
  archived: boolean
}

export interface Project {
  id: string
  name: string
  color: string
  archived: boolean
}

export interface Tag {
  id: string
  name: string
  color: string
}

export interface Transaction {
  id: string
  type: TransactionType
  occurredAt: string
  accountId?: string
  fromAccountId?: string
  toAccountId?: string
  amount: number
  currency: string
  reportingCurrency?: string
  reportingRate?: number
  reportingAmount?: number
  reportingRateDate?: string
  destinationAmount?: number
  exchangeRate?: number
  feeAmount?: number
  feeCurrency?: string
  categoryId?: string
  feeCategoryId?: string
  note: string
  projectId?: string
  tagIds: string[]
  receiptUrl?: string
  receiptLocalId?: string
  debtId?: string
  debtPrincipal?: number
  debtInterest?: number
}

export interface DebtRecord {
  id: string
  direction: 'i-owe' | 'owed-to-me'
  name: string
  counterparty: string
  currency: string
  originalPrincipal: number
  outstandingPrincipal: number
  createdAt: string
  dueAt?: string
  note: string
  archived: boolean
}

export interface StoredRecord<T = unknown> {
  key: string
  kind: EntityKind
  id: string
  payload: T
  version: number
  updatedAt: string
  dirty: boolean
}

export interface PendingChange {
  operationId: string
  kind: EntityKind
  recordId: string
  baseVersion: number
  payload: unknown
  deleted: boolean
  createdAt: string
}

export interface ConflictRecord {
  id: string
  kind: EntityKind
  recordId: string
  localPayload: unknown
  serverPayload: unknown | null
  serverVersion: number
  detectedAt: string
}

export interface PendingAttachment {
  id: string
  transactionId: string
  blob: Blob
  name: string
  createdAt: string
}

export const entityKey = (kind: EntityKind, id: string) => `${kind}:${id}`

export const newId = () => crypto.randomUUID()

export const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
