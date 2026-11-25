import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Banknote, BriefcaseBusiness,
  Camera, Check, CircleDollarSign, Copy, CreditCard, FileText, HandCoins, Home,
  LogOut, Menu, Plus, RefreshCw, Search, Settings2, ShieldCheck, Tags, Trash2,
  Wallet, Wifi, WifiOff, X,
} from 'lucide-react'
import type {
  Account, BalanceAdjustment, Category, ConflictRecord, DebtRecord, EntityKind,
  Project, StoredRecord, Tag as MoneyTag, Transaction, TransactionType,
} from './domain'
import { money, newId } from './domain'
import {
  authDb, deleteRecord, getRecords, localDb, pendingConflicts, resolveConflict,
  saveRecord, setActiveUser,
} from './localDb'
import { syncNow } from './sync'
import './Workspace.css'

interface User { id: string; email: string; name: string; isAdmin: boolean }
interface AppData {
  accounts: Account[]; adjustments: BalanceAdjustment[]; categories: Category[]; projects: Project[]
  tags: MoneyTag[]; transactions: Transaction[]; debts: DebtRecord[]
}
type Page = 'overview' | 'transactions' | 'accounts' | 'debts' | 'organize' | 'settings'
type DialogState = { type: 'account' | 'adjustment' | 'transaction' | 'debt' | 'payment' | 'category' | 'project' | 'tag'; value?: unknown } | null

const emptyData: AppData = { accounts: [], adjustments: [], categories: [], projects: [], tags: [], transactions: [], debts: [] }
const isoLocal = (value = new Date()) => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const amountOf = (value: string) => Math.round((Number.parseFloat(value) || 0) * 100) / 100
const payloads = <T,>(rows: StoredRecord<T>[]) => rows.map((row) => row.payload)

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'include' })
  const result = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'The request could not be completed')
  return result as T
}

async function readData(): Promise<AppData> {
  const [accounts, adjustments, categories, projects, tags, transactions, debts] = await Promise.all([
    getRecords<Account>('account'), getRecords<BalanceAdjustment>('adjustment'),
    getRecords<Category>('category'), getRecords<Project>('project'), getRecords<MoneyTag>('tag'),
    getRecords<Transaction>('transaction'), getRecords<DebtRecord>('debt'),
  ])
  return {
    accounts: payloads(accounts), adjustments: payloads(adjustments), categories: payloads(categories),
    projects: payloads(projects), tags: payloads(tags), transactions: payloads(transactions), debts: payloads(debts),
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

function Dialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  return <div className="dialog-shade" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true"><header className="dialog-head"><div><small>MONTRACK</small><h2>{title}</h2></div><button className="icon-btn" aria-label="Close" onClick={close}><X size={18} /></button></header>{children}</section></div>
}

function SignIn({ onLogin }: { onLogin: (user: User) => Promise<void> }) {
  const inviteToken = new URLSearchParams(location.search).get('invite')
  const [email, setEmail] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (inviteToken) request<{ email: string }>(`/api/invitations/${encodeURIComponent(inviteToken)}`).then((item) => setInviteEmail(item.email)).catch((reason: Error) => setError(reason.message))
  }, [inviteToken])
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const user = inviteToken
        ? await request<User>('/api/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken, name, password }) })
        : await request<User>('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      await onLogin(user); history.replaceState({}, '', '/')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to sign in') }
    finally { setBusy(false) }
  }
  return <main className="sign-in"><div className="sign-brand"><i><CircleDollarSign size={20} /></i> MonTrack</div><div className="sign-content"><div className="sign-copy"><span className="eyebrow">YOUR MONEY, IN YOUR HANDS</span><h1>Clarity for<br /><em>everyday money.</em></h1><p>Track spending, balances and lending across your accounts. Keep working offline; your changes sync when you reconnect.</p><span className="privacy-note"><ShieldCheck size={16} /> Private workspace · invitation only</span></div><form className="sign-form" onSubmit={submit}><span className="eyebrow">{inviteToken ? 'YOU HAVE AN INVITATION' : 'WELCOME BACK'}</span><h2>{inviteToken ? 'Create your account' : 'Sign in to MonTrack'}</h2><p>{inviteToken ? inviteEmail || 'Checking invitation…' : 'Use the credentials provided for your account.'}</p>{inviteToken ? <Field label="Your name"><input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></Field> : <Field label="Email"><input required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>}<Field label="Password"><input required type="password" minLength={inviteToken ? 10 : 1} autoComplete={inviteToken ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>{error && <p className="error-note">{error}</p>}<button className="button primary fill" disabled={busy || Boolean(inviteToken && !inviteEmail)}>{busy ? 'Please wait…' : inviteToken ? 'Create account' : 'Sign in'}<ArrowRight size={16} /></button><small className="sign-foot"><ShieldCheck size={13} /> Your data stays on your private server.</small></form></div><footer className="sign-footer"><span>MONTRACK / PERSONAL FINANCE</span><span>OFFLINE READY</span></footer></main>
}

function Workspace() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<AppData>(emptyData)
  const [page, setPage] = useState<Page>('overview')
  const [dialog, setDialog] = useState<DialogState>(null)
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const [syncText, setSyncText] = useState('All changes saved')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const retryCount = useRef(0)
  const retryTimer = useRef<number | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<TransactionType | 'all'>('all')
  const [currency, setCurrency] = useState('USD')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteUrl, setInviteUrl] = useState('')
  const [message, setMessage] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [fxRates, setFxRates] = useState<Record<string, number>>({})
  const [fxDate, setFxDate] = useState('')

  async function refresh() {
    setData(await readData())
    setConflicts(await pendingConflicts())
  }

  async function login(nextUser: User) {
    setActiveUser(nextUser.id)
    await authDb.settings.put({ key: 'cachedUser', value: JSON.stringify(nextUser) })
    setUser(nextUser)
  }

  useEffect(() => {
    let active = true
    async function init() {
      try {
        const remote = await request<User>('/api/me')
        if (active) await login(remote)
      } catch {
        const cached = await authDb.settings.get('cachedUser')
        if (active && cached) {
          const cachedUser = JSON.parse(cached.value) as User
          setActiveUser(cachedUser.id)
          setUser(cachedUser)
        }
      } finally { if (active) setLoading(false) }
    }
    void init()
    const onOnline = () => {
      setOnline(true)
      window.setTimeout(() => { void synchronize() }, 900)
    }
    const onOffline = () => {
      setOnline(false)
      setSyncText('Offline · changes saved on this device')
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    const onVisible = () => { if (document.visibilityState === 'visible' && navigator.onLine) void synchronize() }
    addEventListener('online', onOnline); addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      removeEventListener('online', onOnline)
      removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    let active = true
    void refresh()
    void localDb.settings.get('reportingCurrency').then((setting) => { if (active && setting) setCurrency(setting.value) })
    return () => { active = false }
  }, [user])

  useEffect(() => {
    if (!user) return
    let active = true
    const key = `fxRates:${currency}`
    setFxRates({})
    setFxDate('')
    void (async () => {
      const cached = await localDb.settings.get(key)
      if (active && cached) {
        const quote = JSON.parse(cached.value) as { date: string; rates: Record<string, number> }
        setFxRates(quote.rates)
        setFxDate(quote.date)
      }
      if (!online) return
      try {
        const quote = await request<{ date: string; rates: Record<string, number> }>(`/api/rates/${currency}`)
        if (active) {
          setFxRates(quote.rates)
          setFxDate(quote.date)
          await localDb.settings.put({ key, value: JSON.stringify(quote) })
        }
      } catch { /* Cached rates remain available offline. */ }
    })()
    return () => { active = false }
  }, [user, currency, online])

  useEffect(() => {
    if (!user || !online) return
    const timeout = window.setTimeout(() => { void synchronize() }, 900)
    return () => window.clearTimeout(timeout)
  }, [user, online])

  async function synchronize() {
    if (!navigator.onLine || busyRef.current) return
    busyRef.current = true; setBusy(true); setSyncText('Syncing…')
    try {
      const firstPass = await syncNow()
      const files = await localDb.attachments.toArray()
      for (const file of files) {
        const body = new FormData(); body.append('receipt', file.blob, file.name)
        const uploaded = await request<{ url: string }>(`/api/attachments/${encodeURIComponent(file.transactionId)}`, { method: 'POST', body })
        const stored = await localDb.records.get(`transaction:${file.transactionId}`)
        if (stored) {
          const transaction = stored.payload as Transaction
          await saveRecord('transaction', transaction.id, { ...transaction, receiptUrl: uploaded.url, receiptLocalId: undefined }, stored.version)
        }
        await localDb.attachments.delete(file.id)
      }
      if (files.length) await syncNow()
      await refresh()
      retryCount.current = 0
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
      retryTimer.current = null
      setSyncText(firstPass.conflictCount ? `${firstPass.conflictCount} conflict${firstPass.conflictCount === 1 ? '' : 's'} to resolve` : 'All changes saved')
    } catch {
      setSyncText(navigator.onLine ? 'Sync paused · will retry' : 'Offline · changes saved on this device')
      if (navigator.onLine && retryTimer.current === null) {
        const delay = Math.min(30_000, 1_000 * (2 ** Math.min(retryCount.current, 5)))
        retryCount.current += 1
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null
          void synchronize()
        }, delay)
      }
    }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function write(kind: EntityKind, id: string, payload: unknown, deferSync = false) {
    const stored = await localDb.records.get(`${kind}:${id}`)
    let valueToSave = payload
    if (kind === 'transaction') {
      const transaction = payload as Transaction
      const existing = stored?.payload as Transaction | undefined
      if (existing) {
        valueToSave = {
          ...transaction,
          reportingCurrency: existing.reportingCurrency,
          reportingRate: existing.reportingRate,
          reportingAmount: existing.reportingAmount,
          reportingRateDate: existing.reportingRateDate,
        }
      } else {
        let rates = fxRates
        let rateDate = fxDate
        if (navigator.onLine && transaction.currency !== currency) {
          try {
            const quote = await request<{ date: string; rates: Record<string, number> }>(`/api/rates/${currency}`)
            rates = quote.rates
            rateDate = quote.date
            setFxRates(rates)
            setFxDate(rateDate)
            await localDb.settings.put({ key: `fxRates:${currency}`, value: JSON.stringify(quote) })
          } catch { /* Use the last cached quote when the provider is unavailable. */ }
        }
        const reportingRate = transaction.currency === currency
          ? 1
          : rates[transaction.currency] ? 1 / rates[transaction.currency] : undefined
        valueToSave = {
          ...transaction,
          reportingCurrency: currency,
          reportingRate,
          reportingAmount: reportingRate === undefined ? undefined : transaction.amount * reportingRate,
          reportingRateDate: reportingRate === undefined ? undefined : rateDate || undefined,
        }
      }
    }
    await saveRecord(kind, id, valueToSave, stored?.version ?? 0)
    await refresh()
    setSyncText(navigator.onLine ? 'Changes waiting to sync' : 'Offline · changes saved on this device')
    if (navigator.onLine && !deferSync) void synchronize()
  }

  async function remove(kind: EntityKind, id: string) {
    await deleteRecord(kind, id)
    await refresh()
    setSyncText(navigator.onLine ? 'Changes waiting to sync' : 'Offline · changes saved on this device')
    if (navigator.onLine) void synchronize()
  }

  async function logout() {
    try { await request('/api/auth/logout', { method: 'POST' }) } catch { /* sign-out still works offline */ }
    await authDb.settings.delete('cachedUser'); setUser(null); setData(emptyData)
  }

  if (loading) return <div className="loading"><i><CircleDollarSign size={20} /></i> Opening your ledger…</div>
  if (!user) return <SignIn onLogin={login} />

  const sortedTransactions = [...data.transactions].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  const filteredTransactions = sortedTransactions.filter((item) => {
    const category = data.categories.find((entry) => entry.id === item.categoryId)?.name ?? ''
    return (filter === 'all' || item.type === filter) && `${item.note} ${category} ${item.currency}`.toLowerCase().includes(search.toLowerCase())
  })
  const firstOfMonth = new Date(); firstOfMonth.setDate(1); firstOfMonth.setHours(0, 0, 0, 0)
  const monthly = sortedTransactions.filter((item) => new Date(item.occurredAt) >= firstOfMonth)
  const navItems: { key: Page; label: string; icon: typeof Home }[] = [
    { key: 'overview', label: 'Overview', icon: Home }, { key: 'transactions', label: 'Transactions', icon: ArrowLeftRight },
    { key: 'accounts', label: 'Accounts', icon: Wallet }, { key: 'debts', label: 'Debt & loans', icon: HandCoins },
    { key: 'organize', label: 'Categories & labels', icon: Tags }, { key: 'settings', label: 'Settings', icon: Settings2 },
  ]
  const titles: Record<Page, string> = { overview: 'Overview', transactions: 'Transactions', accounts: 'Accounts', debts: 'Debt & loans', organize: 'Categories & labels', settings: 'Settings' }
  const pageCopy: Record<Page, string> = {
    overview: 'A clear view of where your money is moving.', transactions: 'Your complete record, across every account.',
    accounts: 'Balances and adjustments, all in one place.', debts: 'Keep track of what you owe and what is owed to you.',
    organize: 'Keep your activity organized your way.', settings: 'Your private workspace and sync preferences.',
  }
  const balance = (account: Account) => {
    const now = Date.now()
    const adjusted = data.adjustments
      .filter((entry) => entry.accountId === account.id && new Date(entry.occurredAt).getTime() <= now)
      .reduce((sum, entry) => sum + entry.amount, 0)
    return data.transactions.reduce((sum, entry) => {
      if (new Date(entry.occurredAt).getTime() > now) return sum
      if (entry.type === 'transfer') {
        if (entry.fromAccountId === account.id) return sum - entry.amount - (entry.feeCurrency === account.currency ? entry.feeAmount ?? 0 : 0)
        if (entry.toAccountId === account.id) return sum + (entry.destinationAmount ?? entry.amount)
        return sum
      }
      return entry.accountId === account.id ? sum + (entry.type === 'income' ? entry.amount : -entry.amount) : sum
    }, adjusted)
  }
  const convert = (value: number, code: string) => {
    if (code === currency) return value
    const rate = fxRates[code]
    return rate && rate > 0 ? value / rate : null
  }
  const totals = (items: Transaction[], type: 'expense' | 'income') => {
    let convertedTotal = 0
    const unavailable = new Map<string, number>()
    const add = (transaction: Transaction, code: string, value: number) => {
      const rate = code === currency
        ? 1
        : transaction.currency === code && transaction.reportingCurrency === currency
          ? transaction.reportingRate
          : undefined
      if (rate === undefined) unavailable.set(code, (unavailable.get(code) ?? 0) + value)
      else convertedTotal += value * rate
    }
    for (const item of items) {
      if (item.type === type) {
        add(item, item.currency, Math.max(0, item.amount - (item.debtPrincipal ?? 0)))
      }
      if (type === 'expense' && item.type === 'transfer' && item.feeAmount) {
        add(item, item.feeCurrency ?? item.currency, item.feeAmount)
      }
    }
    const parts = convertedTotal ? [money(convertedTotal, currency)] : []
    parts.push(...[...unavailable].map(([code, value]) => money(value, code)))
    return parts.join(' + ') || money(0, currency)
  }

  async function resolve(choice: 'server' | 'local') {
    const conflict = conflicts[0]; if (!conflict) return
    if (choice === 'local') await resolveConflict(conflict, conflict.localPayload)
    else {
      await localDb.transaction('rw', localDb.records, localDb.outbox, localDb.conflicts, async () => {
        await localDb.outbox.where('[kind+recordId]').equals([conflict.kind, conflict.recordId]).delete()
        if (conflict.serverPayload === null) await localDb.records.delete(`${conflict.kind}:${conflict.recordId}`)
        else await localDb.records.put({ key: `${conflict.kind}:${conflict.recordId}`, kind: conflict.kind, id: conflict.recordId, payload: conflict.serverPayload, version: conflict.serverVersion, updatedAt: new Date().toISOString(), dirty: false })
        await localDb.conflicts.delete(conflict.id)
      })
    }
    await refresh(); setMessage(choice === 'local' ? 'Your version will sync next.' : 'The server version was kept.')
    if (choice === 'local' && navigator.onLine) void synchronize()
  }

  async function saveTransaction(transaction: Transaction, file?: File) {
    await write('transaction', transaction.id, transaction, true)
    if (file && transaction.receiptLocalId) {
      await localDb.attachments.put({ id: transaction.receiptLocalId, transactionId: transaction.id, blob: file, name: file.name, createdAt: new Date().toISOString() })
    }
    setDialog(null)
    if (navigator.onLine) void synchronize()
  }

  const headerTitle = page === 'overview' ? `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${user.name.split(' ')[0]}.` : titles[page]

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'opened' : ''}`}><div className="brand"><i><CircleDollarSign size={20} /></i><span>MonTrack</span><button className="icon-btn mobile-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}><X size={18} /></button></div><div className="workspace-caption">PERSONAL WORKSPACE</div><nav>{navItems.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${page === key ? 'selected' : ''}`} onClick={() => { setPage(key); setMobileNav(false) }}><Icon size={17} /><span>{label}</span>{key === 'transactions' && conflicts.length > 0 && <b>{conflicts.length}</b>}</button>)}</nav><div className="sidebar-bottom"><div className={`connection ${online ? 'online' : ''}`}><span>{online ? <Wifi size={16} /> : <WifiOff size={16} />}</span><div><strong>{online ? 'Connected' : 'Working offline'}</strong><small>{syncText}</small></div></div><div className="user-row"><i>{user.name.slice(0, 1).toUpperCase()}</i><span><strong>{user.name}</strong><small>{user.email}</small></span><button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => void logout()}><LogOut size={15} /></button></div></div></aside>
    <main className="main-area"><header className="topbar"><div className="topbar-left"><button className="icon-btn mobile-open" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={18} /></button><small>MY FINANCES <span>/</span> {titles[page].toUpperCase()}</small></div><div className="topbar-right"><span className={`sync-label ${online ? '' : 'offline'}`}><i />{syncText}</span><button className="icon-btn" aria-label="Sync now" title="Sync now" disabled={!online || busy} onClick={() => void synchronize()}><RefreshCw size={16} className={busy ? 'rotate' : ''} /></button><button className="button primary new-transaction" onClick={() => setDialog({ type: 'transaction' })}><Plus size={16} /> New transaction</button></div></header>
      <div className="content"><section className="page-title"><div><span className="eyebrow">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</span><h1>{headerTitle}</h1><p>{pageCopy[page]}</p></div>{page === 'overview' && <button className="button secondary" onClick={() => void synchronize()} disabled={!online || busy}><RefreshCw size={15} className={busy ? 'rotate' : ''} /> Sync now</button>}</section>
        {page === 'overview' && <Overview data={data} balance={balance} totals={totals} monthly={monthly} recent={sortedTransactions.slice(0, 5)} navigate={setPage} add={() => setDialog({ type: 'transaction' })} convert={convert} reportingCurrency={currency} fxDate={fxDate} />}
        {page === 'transactions' && <Transactions data={data} items={filteredTransactions} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} edit={(transaction) => setDialog({ type: 'transaction', value: transaction })} remove={(transaction) => void remove('transaction', transaction.id)} add={() => setDialog({ type: 'transaction' })} />}
        {page === 'accounts' && <Accounts data={data} balance={balance} create={() => setDialog({ type: 'account' })} adjust={() => setDialog({ type: 'adjustment' })} />}
        {page === 'debts' && <Debts data={data} create={() => setDialog({ type: 'debt' })} pay={(debt) => setDialog({ type: 'payment', value: debt })} />}
        {page === 'organize' && <Organize data={data} create={(type) => setDialog({ type })} remove={(kind, id) => void remove(kind, id)} />}
        {page === 'settings' && <Settings user={user} currency={currency} setCurrency={async (value) => { setCurrency(value); await localDb.settings.put({ key: 'reportingCurrency', value }) }} inviteEmail={inviteEmail} setInviteEmail={setInviteEmail} inviteUrl={inviteUrl} createInvite={async () => { const result = await request<{ token: string }>('/api/admin/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: inviteEmail }) }); setInviteUrl(`${location.origin}/?invite=${encodeURIComponent(result.token)}`); setInviteEmail('') }} exportCsv={() => exportTransactions(data.transactions)} />}
      </div>
    </main>
    {mobileNav && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileNav(false)} />}
    {dialog?.type === 'account' && <AccountForm close={() => setDialog(null)} save={async (account, adjustment) => { await write('account', account.id, account, true); if (adjustment) await write('adjustment', adjustment.id, adjustment, true); setDialog(null); if (navigator.onLine) void synchronize() }} />}
    {dialog?.type === 'adjustment' && <AdjustmentForm accounts={data.accounts} close={() => setDialog(null)} save={async (item) => { await write('adjustment', item.id, item); setDialog(null) }} />}
    {dialog?.type === 'transaction' && <TransactionForm accounts={data.accounts} categories={data.categories} projects={data.projects} tags={data.tags} existingTransactions={data.transactions} initial={dialog.value as Transaction | undefined} close={() => setDialog(null)} save={saveTransaction} />}
    {dialog?.type === 'debt' && <DebtForm accounts={data.accounts} close={() => setDialog(null)} save={async (debt, transaction) => { await write('debt', debt.id, debt, true); await write('transaction', transaction.id, transaction, true); setDialog(null); if (navigator.onLine) void synchronize() }} />}
    {dialog?.type === 'payment' && <PaymentForm debt={dialog.value as DebtRecord} accounts={data.accounts} close={() => setDialog(null)} save={async (debt, transaction) => { await write('debt', debt.id, debt, true); await write('transaction', transaction.id, transaction, true); setDialog(null); if (navigator.onLine) void synchronize() }} />}
    {['category', 'project', 'tag'].includes(dialog?.type ?? '') && <LabelForm type={dialog!.type as 'category' | 'project' | 'tag'} close={() => setDialog(null)} save={async (kind, id, item) => { await write(kind, id, item); setDialog(null) }} />}
    {conflicts[0] && <ConflictPrompt conflict={conflicts[0]} choose={resolve} />}
    {message && <div className="toast" role="status">{message}<button className="icon-btn" aria-label="Dismiss" onClick={() => setMessage('')}><X size={14} /></button></div>}
  </div>
}

function AccountIcon({ account }: { account: Account }) {
  const name = account.name.toLowerCase()
  return name.includes('cash') ? <Banknote size={17} /> : name.includes('card') ? <CreditCard size={17} /> : <Wallet size={17} />
}

function Empty({ icon, title, text, action, onClick }: { icon: ReactNode; title: string; text: string; action?: string; onClick?: () => void }) {
  return <div className="empty"><i>{icon}</i><strong>{title}</strong><p>{text}</p>{action && <button className="button secondary small" onClick={onClick}><Plus size={14} />{action}</button>}</div>
}

function Overview({ data, balance, totals, monthly, recent, navigate, add, convert, reportingCurrency, fxDate }: {
  data: AppData; balance: (account: Account) => number; totals: (items: Transaction[], type: 'expense' | 'income') => string;
  monthly: Transaction[]; recent: Transaction[]; navigate: (page: Page) => void; add: () => void;
  convert: (amount: number, currency: string) => number | null; reportingCurrency: string; fxDate: string;
}) {
  const bars = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(); date.setDate(1); date.setMonth(date.getMonth() - 5 + index)
    const monthItems = data.transactions.filter((item) => new Date(item.occurredAt).getMonth() === date.getMonth() && new Date(item.occurredAt).getFullYear() === date.getFullYear())
    let value = 0
    for (const item of monthItems) {
      const rate = item.currency === reportingCurrency
        ? 1
        : item.reportingCurrency === reportingCurrency ? item.reportingRate : undefined
      if (item.type === 'expense' && rate !== undefined) value += Math.max(0, item.amount - (item.debtPrincipal ?? 0)) * rate
      if (item.type === 'transfer' && item.feeAmount && rate !== undefined) value += item.feeAmount * rate
    }
    return { label: date.toLocaleDateString(undefined, { month: 'short' }), value }
  })
  const max = Math.max(1, ...bars.map((item) => item.value))
  const convertedBalances = data.accounts.map((account) => convert(balance(account), account.currency))
  const unavailable = data.accounts.filter((account) => convert(balance(account), account.currency) === null).map((account) => account.currency)
  const totalBalance = convertedBalances.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  return <>
    <section className="metrics"><article className="metric-card balance-card"><div className="metric-head">ACCOUNT BALANCES <Wallet size={16} /></div><div className="combined-balance"><strong>{money(totalBalance, reportingCurrency)}{unavailable.length > 0 ? ' +' : ''}</strong><small>Current valuation · {unavailable.length ? `${new Set(unavailable).size} rate${new Set(unavailable).size === 1 ? '' : 's'} unavailable` : fxDate ? `rates ${fxDate}` : 'current rates'}</small></div><div className="balance-list">{data.accounts.length ? data.accounts.slice(0, 2).map((account) => <div key={account.id}><strong>{money(balance(account), account.currency)}</strong><small>{account.name}</small></div>) : <div><strong>Add an account</strong><small>Start your ledger</small></div>}</div><button className="link-action" onClick={() => navigate('accounts')}>View accounts <ArrowRight size={13} /></button></article><Metric icon={<ArrowUpRight size={16} />} title="SPENT THIS MONTH" value={totals(monthly, 'expense')} note="Transaction-time rates · principal excluded" /><Metric icon={<ArrowDownLeft size={16} />} title="INCOME THIS MONTH" value={totals(monthly, 'income')} note="Transaction-time rates · principal excluded" /><Metric icon={<HandCoins size={16} />} title="DEBT & LOANS" value={`${data.debts.filter((item) => !item.archived).length} active`} note="Tracked separately" action={() => navigate('debts')} /></section>
    <section className="overview-grid"><article className="panel chart-panel"><div className="panel-head"><div><small>OUTGOING ACTIVITY</small><h2>Spending rhythm</h2></div><span className="period-label">LAST 6 MONTHS · {reportingCurrency}</span></div><div className="chart"><div className="chart-lines"><i /><i /><i /></div><div className="bars">{bars.map((item, index) => <div className="bar" key={`${item.label}-${index}`}><div className={`bar-track ${index === 5 ? 'current' : ''}`}><i style={{ height: `${Math.max(3, item.value / max * 100)}%` }} /></div><small>{item.label}</small></div>)}</div></div><div className="chart-foot"><span><i /> Expenses</span><small>Uses the rate saved with each transaction</small></div></article><article className="panel mini-accounts"><div className="panel-head"><div><small>YOUR MONEY, ORGANIZED</small><h2>Accounts</h2></div><button className="icon-btn" aria-label="View accounts" onClick={() => navigate('accounts')}><ArrowRight size={16} /></button></div>{data.accounts.length ? data.accounts.slice(0, 4).map((account) => <div className="mini-account" key={account.id}><i style={{ background: account.color }}><AccountIcon account={account} /></i><span><strong>{account.name}</strong><small>{account.currency} account</small></span><b>{money(balance(account), account.currency)}</b></div>) : <Empty icon={<Wallet size={20} />} title="Start with an account" text="Add cash, a card, or another account." action="Add account" onClick={() => navigate('accounts')} />}</article></section>
    <section className="panel recent"><div className="panel-head"><div><small>LATEST ACTIVITY</small><h2>Recent transactions</h2></div><button className="link-action" onClick={() => navigate('transactions')}>All transactions <ArrowRight size={13} /></button></div>{recent.length ? <ActivityList items={recent} data={data} /> : <Empty icon={<FileText size={20} />} title="Your ledger starts here" text="Add a transaction to see your activity." action="Add transaction" onClick={add} />}</section>
  </>
}

function Metric({ icon, title, value, note, action }: { icon: ReactNode; title: string; value: string; note: string; action?: () => void }) {
  return <article className="metric-card"><div className="metric-head">{title}{icon}</div><div className="metric-value">{value}</div><div className="metric-note">{note}{action && <button className="inline-link" onClick={action}>Open</button>}</div></article>
}

function ActivityList({ items, data }: { items: Transaction[]; data: AppData }) {
  return <div className="activity-list">{items.map((item) => {
    const category = data.categories.find((entry) => entry.id === item.categoryId)
    const account = data.accounts.find((entry) => entry.id === item.accountId)
    const from = data.accounts.find((entry) => entry.id === item.fromAccountId)
    const to = data.accounts.find((entry) => entry.id === item.toAccountId)
    const Icon = item.type === 'income' ? ArrowDownLeft : item.type === 'expense' ? ArrowUpRight : ArrowLeftRight
    return <div className="activity-row" key={item.id}><i className={`activity-icon ${item.type}`}><Icon size={16} /></i><span><strong>{item.note || category?.name || item.type}</strong><small>{category?.name ?? (item.type === 'transfer' ? `${from?.name ?? 'Account'} → ${to?.name ?? 'Account'}` : account?.name ?? 'Account')} · {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(item.occurredAt))}</small></span><b className={item.type === 'income' ? 'positive' : item.type === 'expense' ? 'negative' : ''}>{item.type === 'transfer' ? `${money(item.amount, item.currency)} → ${money(item.destinationAmount ?? item.amount, to?.currency ?? item.currency)}` : `${item.type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}`}</b></div>
  })}</div>
}

function Transactions({ data, items, filter, setFilter, search, setSearch, edit, remove, add }: { data: AppData; items: Transaction[]; filter: TransactionType | 'all'; setFilter: (filter: TransactionType | 'all') => void; search: string; setSearch: (value: string) => void; edit: (item: Transaction) => void; remove: (item: Transaction) => void; add: () => void }) {
  return <section className="panel transactions-panel"><div className="table-tools"><div className="filter-tabs">{(['all', 'expense', 'income', 'transfer'] as const).map((type) => <button key={type} className={filter === type ? 'active' : ''} onClick={() => setFilter(type)}>{type === 'all' ? 'All activity' : type[0].toUpperCase() + type.slice(1)}</button>)}</div><label className="search"><Search size={15} /><input placeholder="Search transactions" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>{items.length ? <div className="table-scroll"><table><thead><tr><th>TRANSACTION</th><th>TYPE</th><th>ACCOUNT</th><th>PROJECT / TAGS</th><th>DATE</th><th className="right">AMOUNT</th><th /></tr></thead><tbody>{items.map((item) => {
    const category = data.categories.find((entry) => entry.id === item.categoryId)
    const project = data.projects.find((entry) => entry.id === item.projectId)
    const account = data.accounts.find((entry) => entry.id === item.accountId)
    const from = data.accounts.find((entry) => entry.id === item.fromAccountId)
    const to = data.accounts.find((entry) => entry.id === item.toAccountId)
    return <tr key={item.id}><td><strong className="tx-title">{item.note || category?.name || 'Untitled transaction'}{item.receiptUrl ? <a className="receipt-link" href={item.receiptUrl} target="_blank" rel="noreferrer" title="View receipt"><Camera size={13} /></a> : item.receiptLocalId && <span title="Receipt waiting to sync"><Camera size={13} /></span>}</strong><small>{category?.name ?? (item.type === 'transfer' ? `${from?.name} → ${to?.name}` : '')}</small></td><td><span className={`pill ${item.type}`}>{item.type}</span></td><td>{item.type === 'transfer' ? from?.name : account?.name}</td><td><div className="chips">{project && <i>{project.name}</i>}{item.tagIds.slice(0, 2).map((id) => <i key={id}>{data.tags.find((tag) => tag.id === id)?.name}</i>)}</div></td><td>{new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(item.occurredAt))}</td><td className={`right amount ${item.type}`}>{item.type === 'transfer' ? `${money(item.amount, item.currency)} → ${money(item.destinationAmount ?? item.amount, to?.currency ?? item.currency)}` : `${item.type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}`}</td><td className="row-actions"><button className="icon-btn" title="Edit transaction" aria-label="Edit transaction" onClick={() => edit(item)}><Settings2 size={14} /></button><button className="icon-btn remove" title="Delete transaction" aria-label="Delete transaction" onClick={() => remove(item)}><Trash2 size={14} /></button></td></tr>
  })}</tbody></table></div> : <Empty icon={<FileText size={20} />} title="No transactions found" text="Try another filter or record your first transaction." action="New transaction" onClick={add} />}</section>
}

function Accounts({ data, balance, create, adjust }: { data: AppData; balance: (account: Account) => number; create: () => void; adjust: () => void }) {
  return <><div className="section-tools"><span>{data.accounts.length} account{data.accounts.length === 1 ? '' : 's'} · dated adjustments included</span><div><button className="button secondary" disabled={!data.accounts.length} onClick={adjust}><Plus size={15} /> Balance adjustment</button><button className="button primary" onClick={create}><Plus size={15} /> Add account</button></div></div>{data.accounts.length ? <div className="account-grid">{data.accounts.map((account) => <article className="account-card" key={account.id}><div className="account-card-top"><i style={{ background: account.color }}><AccountIcon account={account} /></i><span className="active-mark"><i /> ACTIVE</span></div><small>{account.currency} ACCOUNT</small><h2>{account.name}</h2><strong>{money(balance(account), account.currency)}</strong><p>Opening adjustment {money(account.openingBalance, account.currency)} · {data.adjustments.filter((entry) => entry.accountId === account.id).length} total adjustments</p></article>)}</div> : <section className="panel"><Empty icon={<Wallet size={20} />} title="No accounts yet" text="Create an account to establish its opening balance and start tracking." action="Add account" onClick={create} /></section>}</>
}

function Debts({ data, create, pay }: { data: AppData; create: () => void; pay: (debt: DebtRecord) => void }) {
  const active = data.debts.filter((item) => !item.archived)
  return <><div className="section-tools"><span>Principal is tracked separately from income and expenses.</span><button className="button primary" onClick={create}><Plus size={15} /> Record debt or loan</button></div><div className="debt-stats"><article><small>OWED TO YOU</small><strong>{active.filter((item) => item.direction === 'owed-to-me').length} <i>records</i></strong><p>Money you have lent or are due to receive.</p></article><article><small>YOU OWE</small><strong>{active.filter((item) => item.direction === 'i-owe').length} <i>records</i></strong><p>Borrowed money and outstanding repayments.</p></article></div>{active.length ? <div className="debt-list">{active.map((debt) => <div className="debt-row" key={debt.id}><i className={debt.direction}><HandCoins size={18} /></i><span><strong>{debt.name}</strong><small>{debt.counterparty} · {debt.direction === 'i-owe' ? 'You owe' : 'Owed to you'}{debt.dueAt ? ` · Due ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(debt.dueAt))}` : ''}</small></span><b><small>OUTSTANDING</small>{money(debt.outstandingPrincipal, debt.currency)}</b><button className="button secondary small" onClick={() => pay(debt)}><Plus size={14} /> Payment</button></div>)}</div> : <section className="panel"><Empty icon={<HandCoins size={20} />} title="No debt or loan records" text="Record money borrowed or lent and link it to an account movement." action="Add record" onClick={create} /></section>}</>
}

function Organize({ data, create, remove }: { data: AppData; create: (type: 'category' | 'project' | 'tag') => void; remove: (kind: EntityKind, id: string) => void }) {
  const sections: { title: string; kind: EntityKind; items: (Category | Project | MoneyTag)[]; type: 'category' | 'project' | 'tag' }[] = [
    { title: 'Expense categories', kind: 'category', type: 'category', items: data.categories.filter((item) => item.appliesTo === 'expense') },
    { title: 'Income categories', kind: 'category', type: 'category', items: data.categories.filter((item) => item.appliesTo === 'income') },
    { title: 'Projects', kind: 'project', type: 'project', items: data.projects }, { title: 'Tags', kind: 'tag', type: 'tag', items: data.tags },
  ]
  return <div className="organize-grid">{sections.map((section) => <section className="panel organize-card" key={section.title}><header><i>{section.kind === 'project' ? <BriefcaseBusiness size={16} /> : <Tags size={16} />}</i><span><strong>{section.title}</strong><small>{section.items.length} items</small></span><button className="icon-btn" aria-label={`Add ${section.title}`} onClick={() => create(section.type)}><Plus size={16} /></button></header>{section.items.length ? section.items.map((item) => <div className="organize-item" key={item.id}><i style={{ background: item.color }} />{item.name}<button className="icon-btn remove" aria-label={`Delete ${item.name}`} onClick={() => remove(section.kind, item.id)}><Trash2 size={13} /></button></div>) : <p className="muted">Nothing here yet.</p>}</section>)}</div>
}

function Settings({ user, currency, setCurrency, inviteEmail, setInviteEmail, inviteUrl, createInvite, exportCsv }: { user: User; currency: string; setCurrency: (value: string) => void; inviteEmail: string; setInviteEmail: (value: string) => void; inviteUrl: string; createInvite: () => Promise<void>; exportCsv: () => void }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  async function invite() { setError(''); try { await createInvite() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create invitation') } }
  return <div className="settings-grid"><section className="panel settings-card"><header><i><CircleDollarSign size={17} /></i><span><strong>Preferences</strong><small>How amounts are presented.</small></span></header><Field label="Reporting currency"><select value={currency} onChange={(event) => setCurrency(event.target.value)}>{['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'NZD', 'CHF'].map((value) => <option key={value}>{value}</option>)}</select></Field><button className="button secondary" onClick={exportCsv}><FileText size={15} /> Export transactions as CSV</button></section><section className="panel settings-card"><header><i><ShieldCheck size={17} /></i><span><strong>Account</strong><small>Private self-hosted profile.</small></span></header><div className="setting-row"><span>Name</span><b>{user.name}</b></div><div className="setting-row"><span>Email</span><b>{user.email}</b></div><div className="setting-row"><span>Access</span><b>{user.isAdmin ? 'Administrator' : 'Invited user'}</b></div></section>{user.isAdmin && <section className="panel settings-card full"><header><i><Plus size={17} /></i><span><strong>Invite a user</strong><small>Invitations expire in seven days and can only be used once.</small></span></header><div className="invite-row"><Field label="Email address"><input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="person@example.com" /></Field><button className="button primary" disabled={!inviteEmail.includes('@')} onClick={() => void invite()}><Plus size={15} /> Create invitation</button></div>{error && <p className="error-note">{error}</p>}{inviteUrl && <div className="invite-url"><span>{inviteUrl}</span><button className="button secondary small" onClick={async () => { await navigator.clipboard.writeText(inviteUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy link'}</button></div>}</section>}<section className="panel settings-card full"><header><i><Wifi size={17} /></i><span><strong>Offline data</strong><small>Changes are stored on this device first, then synced to your server.</small></span></header><p className="muted">Browser storage can be cleared by your device. Reconnect periodically so your server has the latest copy. Back up the Docker data directory regularly.</p></section></div>
}

function AccountForm({ close, save }: { close: () => void; save: (account: Account, adjustment?: BalanceAdjustment) => void }) {
  const [name, setName] = useState(''); const [currency, setCurrency] = useState('USD'); const [opening, setOpening] = useState('0'); const [date, setDate] = useState(isoLocal()); const [color, setColor] = useState('#477864')
  function submit(event: FormEvent) { event.preventDefault(); const id = newId(); const value = amountOf(opening); const occurredAt = new Date(date).toISOString(); const account: Account = { id, name: name.trim(), currency, openingBalance: value, openingAt: occurredAt, color, active: true }; const adjustment = value ? { id: `opening-${id}`, accountId: id, amount: value, occurredAt, note: 'Opening balance' } : undefined; save(account, adjustment) }
  return <Dialog title="Add account" close={close}><form className="dialog-form" onSubmit={submit}><Field label="Account name"><input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Everyday account" /></Field><div className="form-grid"><Field label="Default currency"><select value={currency} onChange={(event) => setCurrency(event.target.value)}>{['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'NZD', 'CHF'].map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Color"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></Field></div><Field label="Opening balance"><input type="number" step="0.01" value={opening} onChange={(event) => setOpening(event.target.value)} /></Field><Field label="Balance as of"><input required type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} /></Field><p className="form-help">Saved as a dated balance adjustment. All transactions and adjustments contribute to the running balance.</p><DialogActions close={close} label="Create account" /></form></Dialog>
}

function AdjustmentForm({ accounts, close, save }: { accounts: Account[]; close: () => void; save: (item: BalanceAdjustment) => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? ''); const [amount, setAmount] = useState(''); const [note, setNote] = useState('Balance correction'); const [date, setDate] = useState(isoLocal())
  return <Dialog title="Balance adjustment" close={close}><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); save({ id: newId(), accountId, amount: amountOf(amount), note: note.trim(), occurredAt: new Date(date).toISOString() }) }}><Field label="Account"><select required value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field><Field label="Amount"><input type="number" required step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Use a negative amount to subtract" /></Field><Field label="Date and time"><input type="datetime-local" required value={date} onChange={(event) => setDate(event.target.value)} /></Field><Field label="Note"><input value={note} onChange={(event) => setNote(event.target.value)} /></Field><DialogActions close={close} label="Save adjustment" /></form></Dialog>
}

function DialogActions({ close, label }: { close: () => void; label: string }) {
  return <footer className="dialog-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button primary"><Check size={15} />{label}</button></footer>
}

function TransactionForm({ accounts, categories, projects, tags, existingTransactions, initial, close, save }: { accounts: Account[]; categories: Category[]; projects: Project[]; tags: MoneyTag[]; existingTransactions: Transaction[]; initial?: Transaction; close: () => void; save: (transaction: Transaction, file?: File) => void }) {
  const [type, setType] = useState<TransactionType>(initial?.type ?? 'expense'); const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id ?? ''); const [fromId, setFromId] = useState(initial?.fromAccountId ?? accounts[0]?.id ?? ''); const [toId, setToId] = useState(initial?.toAccountId ?? accounts[1]?.id ?? ''); const [amount, setAmount] = useState(initial ? String(initial.amount) : ''); const [toAmount, setToAmount] = useState(initial?.destinationAmount ? String(initial.destinationAmount) : ''); const [rate, setRate] = useState(String(initial?.exchangeRate ?? 1)); const [fee, setFee] = useState(initial?.feeAmount ? String(initial.feeAmount) : ''); const [feeCategory, setFeeCategory] = useState(initial?.feeCategoryId ?? ''); const [categoryId, setCategoryId] = useState(initial?.categoryId ?? ''); const [note, setNote] = useState(initial?.note ?? ''); const [date, setDate] = useState(isoLocal(initial ? new Date(initial.occurredAt) : new Date())); const [projectId, setProjectId] = useState(initial?.projectId ?? ''); const [tagIds, setTagIds] = useState(initial?.tagIds ?? []); const [file, setFile] = useState<File>(); const [rateMessage, setRateMessage] = useState('')
  const [possibleDuplicate, setPossibleDuplicate] = useState<Transaction | null>(null)
  const [pendingSave, setPendingSave] = useState<Transaction | null>(null)
  const source = accounts.find((item) => item.id === fromId); const destination = accounts.find((item) => item.id === toId); const account = accounts.find((item) => item.id === accountId); const crossCurrency = type === 'transfer' && source?.currency !== destination?.currency
  async function fetchRate() { if (!source || !destination) return; setRateMessage('Loading…'); try { const result = await request<{ rates: Record<string, number> }>(`/api/rates/${source.currency}`); const nextRate = result.rates[destination.currency]; if (!nextRate) throw new Error('Rate not available'); setRate(String(nextRate)); setToAmount(String(Math.round(amountOf(amount) * nextRate * 100) / 100)); setRateMessage('Current rate applied') } catch { setRateMessage('Unavailable; enter the rate manually') } }
  function submit(event: FormEvent) {
    event.preventDefault()
    const transaction: Transaction = {
      id: initial?.id ?? newId(), type, occurredAt: new Date(date).toISOString(), amount: amountOf(amount),
      currency: type === 'transfer' ? source?.currency ?? 'USD' : account?.currency ?? 'USD',
      accountId: type === 'transfer' ? undefined : accountId,
      fromAccountId: type === 'transfer' ? fromId : undefined,
      toAccountId: type === 'transfer' ? toId : undefined,
      destinationAmount: type === 'transfer' ? amountOf(toAmount || amount) : undefined,
      exchangeRate: crossCurrency ? Number(rate) : undefined,
      feeAmount: fee ? amountOf(fee) : undefined,
      feeCurrency: type === 'transfer' ? source?.currency : undefined,
      feeCategoryId: feeCategory || undefined,
      categoryId: type === 'transfer' ? undefined : categoryId || undefined,
      note: note.trim(), projectId: projectId || undefined, tagIds,
      receiptUrl: initial?.receiptUrl, receiptLocalId: file ? newId() : initial?.receiptLocalId,
    }
    const candidate = existingTransactions.find((item) => {
      if (item.id === transaction.id || item.type !== transaction.type) return false
      if (Math.abs(new Date(item.occurredAt).getTime() - new Date(transaction.occurredAt).getTime()) > 86_400_000) return false
      if (item.type === 'transfer') {
        return item.fromAccountId === transaction.fromAccountId && item.toAccountId === transaction.toAccountId
          && item.currency === transaction.currency && item.amount === transaction.amount
          && item.destinationAmount === transaction.destinationAmount
      }
      return item.accountId === transaction.accountId && item.currency === transaction.currency && item.amount === transaction.amount
    })
    if (candidate) {
      setPossibleDuplicate(candidate)
      setPendingSave(transaction)
      return
    }
    save(transaction, file)
  }
  function saveAnyway() {
    if (pendingSave) save(pendingSave, file)
    setPossibleDuplicate(null)
    setPendingSave(null)
  }
  return <Dialog title={initial ? 'Edit transaction' : 'New transaction'} close={close} wide><form className="dialog-form" onSubmit={submit}><div className="type-tabs">{(['expense', 'income', 'transfer'] as const).map((option) => <button type="button" key={option} className={`${type === option ? 'chosen' : ''} ${option}`} onClick={() => { setType(option); setCategoryId('') }}>{option === 'expense' ? <ArrowUpRight size={15} /> : option === 'income' ? <ArrowDownLeft size={15} /> : <ArrowLeftRight size={15} />}{option[0].toUpperCase() + option.slice(1)}</button>)}</div><div className="form-grid"><Field label={type === 'transfer' ? `Amount leaving (${source?.currency})` : `Amount (${account?.currency})`}><input required autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></Field><Field label="Date and time"><input required type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} /></Field></div>
  {type === 'transfer' ? <><div className="form-grid"><Field label="From account"><select value={fromId} onChange={(event) => setFromId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field><Field label="To account"><select value={toId} onChange={(event) => setToId(event.target.value)}>{accounts.filter((item) => item.id !== fromId).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field></div>{crossCurrency && <div className="form-grid"><Field label={`Amount arriving (${destination?.currency})`}><input type="number" required min="0.01" step="0.01" value={toAmount} onChange={(event) => setToAmount(event.target.value)} /></Field><Field label="Applied rate"><div className="rate-input"><input required type="number" min="0.000001" step="any" value={rate} onChange={(event) => setRate(event.target.value)} /><button className="link-action" type="button" onClick={() => void fetchRate()}>Get current rate</button></div>{rateMessage && <small className="hint">{rateMessage}</small>}</Field></div>}<div className="form-grid"><Field label="Transfer fee (optional)"><input type="number" min="0" step="0.01" value={fee} onChange={(event) => setFee(event.target.value)} placeholder="0.00" /></Field><Field label="Fee expense category"><select value={feeCategory} onChange={(event) => setFeeCategory(event.target.value)}><option value="">Uncategorized fee</option>{categories.filter((item) => item.appliesTo === 'expense').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div></> : <><Field label="Account"><select required value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field><Field label="Category"><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Uncategorized</option>{categories.filter((item) => item.appliesTo === type && !item.archived).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></>}
  <Field label="Note"><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What was this for?" /></Field><div className="form-grid"><Field label="Project"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">No project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Tags"><select multiple value={tagIds} onChange={(event) => setTagIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{tags.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div><label className="receipt-picker"><input type="file" accept="image/*" capture="environment" onChange={(event) => setFile(event.target.files?.[0])} /><span><Camera size={15} />{file?.name ?? (initial?.receiptUrl ? 'Replace receipt photo' : 'Add receipt photo')}</span><small>Saved locally until sync</small></label>{possibleDuplicate && <div className="duplicate-warning" role="alert"><div><strong>Possible duplicate</strong><small>{possibleDuplicate.note || possibleDuplicate.type} · {money(possibleDuplicate.amount, possibleDuplicate.currency)} on {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(possibleDuplicate.occurredAt))}</small></div><button type="button" className="button secondary small" onClick={() => { setPossibleDuplicate(null); setPendingSave(null) }}>Review entry</button><button type="button" className="button primary small" onClick={saveAnyway}>Save anyway</button></div>}<DialogActions close={close} label={initial ? 'Save changes' : 'Save transaction'} /></form></Dialog>
}

function DebtForm({ accounts, close, save }: { accounts: Account[]; close: () => void; save: (debt: DebtRecord, transaction: Transaction) => void }) {
  const [direction, setDirection] = useState<'i-owe' | 'owed-to-me'>('i-owe'); const [name, setName] = useState(''); const [counterparty, setCounterparty] = useState(''); const [accountId, setAccountId] = useState(accounts[0]?.id ?? ''); const [principal, setPrincipal] = useState(''); const [date, setDate] = useState(isoLocal()); const [note, setNote] = useState('')
  function submit(event: FormEvent) { event.preventDefault(); const account = accounts.find((item) => item.id === accountId); if (!account) return; const id = newId(); const amount = amountOf(principal); const occurredAt = new Date(date).toISOString(); const debt: DebtRecord = { id, direction, name: name.trim(), counterparty: counterparty.trim(), currency: account.currency, originalPrincipal: amount, outstandingPrincipal: amount, createdAt: occurredAt, note, archived: false }; const transaction: Transaction = { id: newId(), type: direction === 'i-owe' ? 'income' : 'expense', occurredAt, accountId, amount, currency: account.currency, note: `${direction === 'i-owe' ? 'Borrowed from' : 'Lent to'} ${counterparty}`, tagIds: [], debtId: id, debtPrincipal: amount }; save(debt, transaction) }
  return <Dialog title="Record debt or loan" close={close}><form className="dialog-form" onSubmit={submit}><div className="type-tabs debt-tabs"><button type="button" className={direction === 'i-owe' ? 'chosen' : ''} onClick={() => setDirection('i-owe')}>I borrowed</button><button type="button" className={direction === 'owed-to-me' ? 'chosen' : ''} onClick={() => setDirection('owed-to-me')}>I lent</button></div><Field label="Description"><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Personal loan" /></Field><Field label="Person or organization"><input required value={counterparty} onChange={(event) => setCounterparty(event.target.value)} /></Field><Field label="Account receiving / sending money"><select required value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field><div className="form-grid"><Field label="Principal"><input required type="number" min="0.01" step="0.01" value={principal} onChange={(event) => setPrincipal(event.target.value)} /></Field><Field label="Date and time"><input type="datetime-local" required value={date} onChange={(event) => setDate(event.target.value)} /></Field></div><Field label="Note"><input value={note} onChange={(event) => setNote(event.target.value)} /></Field><p className="form-help">The principal movement is linked to an account transaction and excluded from income or expense totals.</p><DialogActions close={close} label="Save debt record" /></form></Dialog>
}

function PaymentForm({ debt, accounts, close, save }: { debt: DebtRecord; accounts: Account[]; close: () => void; save: (debt: DebtRecord, transaction: Transaction) => void }) {
  const [accountId, setAccountId] = useState(accounts.find((item) => item.currency === debt.currency)?.id ?? accounts[0]?.id ?? ''); const [principal, setPrincipal] = useState(''); const [interest, setInterest] = useState('0'); const [date, setDate] = useState(isoLocal()); const [note, setNote] = useState('')
  function submit(event: FormEvent) { event.preventDefault(); const account = accounts.find((item) => item.id === accountId); if (!account) return; const p = amountOf(principal); const i = amountOf(interest); const updated = { ...debt, outstandingPrincipal: Math.max(0, debt.outstandingPrincipal - p) }; const transaction: Transaction = { id: newId(), type: debt.direction === 'i-owe' ? 'expense' : 'income', occurredAt: new Date(date).toISOString(), accountId, amount: p + i, currency: account.currency, note: note.trim() || `Payment: ${debt.name}`, tagIds: [], debtId: debt.id, debtPrincipal: p, debtInterest: i }; save(updated, transaction) }
  return <Dialog title="Record a payment" close={close}><form className="dialog-form" onSubmit={submit}><div className="payment-summary"><span>{debt.name}</span><b>{money(debt.outstandingPrincipal, debt.currency)} remaining</b></div><Field label="Account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field><div className="form-grid"><Field label="Principal repaid"><input required type="number" min="0.01" max={debt.outstandingPrincipal} step="0.01" value={principal} onChange={(event) => setPrincipal(event.target.value)} /></Field><Field label="Interest / fee"><input type="number" min="0" step="0.01" value={interest} onChange={(event) => setInterest(event.target.value)} /></Field></div><Field label="Date and time"><input type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} /></Field><Field label="Note"><input value={note} onChange={(event) => setNote(event.target.value)} /></Field><p className="form-help">Principal changes the debt balance; interest remains in expense or income reporting.</p><DialogActions close={close} label="Save payment" /></form></Dialog>
}

function LabelForm({ type, close, save }: { type: 'category' | 'project' | 'tag'; close: () => void; save: (kind: EntityKind, id: string, value: unknown) => void }) {
  const [name, setName] = useState(''); const [appliesTo, setAppliesTo] = useState<'expense' | 'income'>('expense')
  function submit(event: FormEvent) { event.preventDefault(); const id = newId(); if (type === 'category') save(type, id, { id, name: name.trim(), appliesTo, color: appliesTo === 'expense' ? '#c7644c' : '#4d8c6c', archived: false }); else save(type, id, { id, name: name.trim(), color: type === 'project' ? '#b28b43' : '#5d8575', ...(type === 'project' ? { archived: false } : {}) }) }
  const title = type === 'category' ? 'New category' : type === 'project' ? 'New project' : 'New tag'
  return <Dialog title={title} close={close}><form className="dialog-form" onSubmit={submit}><Field label={type === 'category' ? 'Category name' : `${type[0].toUpperCase()}${type.slice(1)} name`}><input required autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>{type === 'category' && <Field label="Applies to"><select value={appliesTo} onChange={(event) => setAppliesTo(event.target.value as 'expense' | 'income')}><option value="expense">Expense</option><option value="income">Income</option></select></Field>}<DialogActions close={close} label="Create" /></form></Dialog>
}

function ConflictPrompt({ conflict, choose }: { conflict: ConflictRecord; choose: (choice: 'server' | 'local') => void }) {
  const summary = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return 'Deleted on this device'
    const record = payload as Record<string, unknown>
    return `${String(record.note || record.name || 'Record')} · ${record.amount ? `${record.amount} ${record.currency ?? ''}` : 'updated'}`
  }
  return <div className="conflict-shade"><section className="conflict-dialog" role="dialog" aria-modal="true"><i><RefreshCw size={18} /></i><small>SYNC CONFLICT · {conflict.kind.toUpperCase()}</small><h2>This item changed on two devices.</h2><p>Choose which version to keep. The other version remains available until you decide.</p><div className="conflict-choices"><article><small>THIS DEVICE</small><strong>{summary(conflict.localPayload)}</strong></article><article><small>SERVER VERSION</small><strong>{summary(conflict.serverPayload)}</strong></article></div><footer><button className="button secondary" onClick={() => choose('server')}>Keep server version</button><button className="button primary" onClick={() => choose('local')}>Keep this device’s version</button></footer></section></div>
}

function exportTransactions(transactions: Transaction[]) {
  const rows = [['type', 'occurredAt', 'amount', 'currency', 'note'], ...transactions.map((item) => [item.type, item.occurredAt, String(item.amount), item.currency, item.note])]
  const csv = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'montrack-transactions.csv'; anchor.click(); URL.revokeObjectURL(url)
}

export default Workspace