import { useEffect, useMemo, useState } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Alias, EmailSummary, EmailDetail, EmailListResponse,
  EmailView, Label, MeResponse, CreateAliasInput,
} from '@mailriz/shared';
import { api, ApiError } from './lib/api';
import { timeAgo, formatSize, initials, avatarColor } from './lib/format';
import {
  Inbox, Star, Archive, Trash2, Tag, Plus, Search, Mail, MailOpen,
  RefreshCw, Paperclip, X, Check, FileText, ChevronLeft, Menu,
  Sun, Moon, AlertTriangle,
} from 'lucide-react';

// ---------------------------------------------------------------- helpers

const VIEWS: { id: EmailView; label: string; icon: any }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archived', label: 'Archived', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

/** Shared control chrome: search field, icon buttons, chips. */
const CONTROL =
  'rounded-control border border-border bg-surface-2 transition ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const ICON_BUTTON =
  'grid size-[38px] shrink-0 place-items-center ' + CONTROL +
  ' text-text-dim hover:bg-surface-3 hover:text-text';

// ---------------------------------------------------------------- hooks

function useMe() {
  return useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get('/api/me'),
    // A 401 is an answer, not a failure to retry — it's what puts the login
    // screen on screen.
    retry: false,
  });
}

function useAliases() {
  return useQuery<Alias[]>({ queryKey: ['aliases'], queryFn: () => api.get('/api/aliases') });
}

function useLabels() {
  return useQuery<Label[]>({ queryKey: ['labels'], queryFn: () => api.get('/api/labels') });
}

function useEmails(view: EmailView, aliasId: string | null, labelId: string | null, q: string) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<EmailSummary[]>([]);

  const query = useQuery<EmailListResponse>({
    queryKey: ['emails', view, aliasId, labelId, q, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ view, limit: '25' });
      if (aliasId) params.set('alias_id', aliasId);
      if (labelId) params.set('label_id', labelId);
      if (q) params.set('q', q);
      if (cursor) params.set('cursor', cursor);
      return api.get(`/api/emails?${params}`);
    },
  });

  // Merge pages.
  const all = useMemo(() => {
    if (query.data) {
      if (cursor === null) return query.data.emails;
      const seen = new Set(items.map((i) => i.id));
      return [...items, ...query.data.emails.filter((e) => !seen.has(e.id))];
    }
    return items;
  }, [query.data, cursor, items]);

  const loadMore = () => {
    if (query.data?.next_cursor) {
      setItems(all);
      setCursor(query.data.next_cursor);
    }
  };

  return { emails: all, next: query.data?.next_cursor || null, loadMore, refetch: query.refetch, isLoading: query.isLoading };
}

/** Light by default; the choice is mirrored onto <html data-theme> and stored.
 *  index.html replays it before first paint so there's no flash on reload. */
function useTheme() {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === 'dark'
  );

  useEffect(() => {
    if (dark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem('mailriz.theme', dark ? 'dark' : 'light');
    } catch {}
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

// ---------------------------------------------------------------- main app

/** Gate: /api/me decides whether we can show the dashboard at all. Keeping
 *  the rest of the app behind it means no other query fires — and fails —
 *  before we know the caller is authenticated. */
export default function App() {
  const theme = useTheme();
  const me = useMe();

  if (me.isPending) return <Splash theme={theme} />;

  // In access mode Cloudflare challenges at the edge, so a 401 arriving in the
  // browser means this deployment uses the session-password fallback.
  if (me.isError && (me.error as ApiError)?.status === 401) {
    return <LoginScreen theme={theme} />;
  }

  return <Dashboard me={me.data} theme={theme} />;
}

type Theme = ReturnType<typeof useTheme>;

function Dashboard({ me, theme }: { me?: MeResponse; theme: Theme }) {
  const [view, setView] = useState<EmailView>('inbox');
  const [aliasId, setAliasId] = useState<string | null>(null);
  const [labelId, setLabelId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewAlias, setShowNewAlias] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const aliases = useAliases();
  const labels = useLabels();
  const emails = useEmails(view, aliasId, labelId, q);

  // Poll every 25s + on focus.
  usePolling(emails.refetch, 25_000);

  const selectedEmail = emails.emails.find((e) => e.id === selectedId) || null;

  const activeAlias = aliases.data?.find((a) => a.id === aliasId) || null;
  const activeLabel = labels.data?.find((l) => l.id === labelId) || null;
  const scope = activeAlias
    ? `@${activeAlias.local_part}`
    : activeLabel
      ? activeLabel.name
      : VIEWS.find((v) => v.id === view)!.label;

  const pick = (next: () => void) => {
    next();
    setSelectedId(null);
    setNavOpen(false);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      {/* Off-canvas scrim, below lg only */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <Sidebar
        open={navOpen}
        close={() => setNavOpen(false)}
        view={view}
        aliasId={aliasId}
        labelId={labelId}
        aliases={aliases.data}
        labels={labels.data}
        onPickAlias={(id) => pick(() => { setAliasId(id); setLabelId(null); })}
        onPickLabel={(id) => pick(() => { setLabelId(id); setAliasId(null); })}
        onNewAlias={() => { setShowNewAlias(true); setNavOpen(false); }}
        me={me}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          scope={scope}
          q={q}
          setQ={setQ}
          onRefresh={emails.refetch}
          onMenu={() => setNavOpen(true)}
          dark={theme.dark}
          toggleTheme={theme.toggle}
        />

        <main className="flex min-h-0 flex-1 flex-col gap-5 p-4 sm:p-6">
          <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div>
              <h1 className="text-xl font-extrabold tracking-tight">Mail</h1>
              <p className="mt-1 text-[14px] text-text-dim">
                Private inbox with disposable aliases, labels, and blocked remote images.
              </p>
            </div>
            <p className="text-[13px] text-text-faint">
              {scope} · {emails.emails.length}
              {emails.next ? '+' : ''} {emails.emails.length === 1 ? 'message' : 'messages'}
            </p>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-[var(--shadow)] lg:flex-row">
            <FolderRail
              view={view}
              scoped={!!(aliasId || labelId)}
              unread={emails.emails.filter((e) => !e.is_read).length}
              hasMore={!!emails.next}
              onPick={(v) => pick(() => { setView(v); setAliasId(null); setLabelId(null); })}
            />

            {/* List and reading pane only sit side by side from xl up. Below
                that the card is too narrow for three columns, so the reading
                pane takes over the list's space while a message is open. */}
            <div
              className={clsx(
                'min-h-0 flex-1 flex-col border-border xl:flex xl:w-[360px] xl:flex-none xl:border-r',
                selectedId ? 'hidden' : 'flex'
              )}
            >
              <EmailList
                emails={emails.emails}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                loadMore={emails.loadMore}
                hasMore={emails.next !== null}
                isLoading={emails.isLoading}
              />
            </div>

            <div
              className={clsx(
                'min-h-0 flex-1 flex-col xl:flex',
                selectedId ? 'flex' : 'hidden'
              )}
            >
              {selectedEmail ? (
                <ReadingPane emailId={selectedEmail.id} onBack={() => setSelectedId(null)} />
              ) : (
                <EmptyPane />
              )}
            </div>
          </div>
        </main>
      </div>

      {showNewAlias && (
        <NewAliasModal onClose={() => setShowNewAlias(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- auth screens

/** Brand lockup shared by the splash and login screens. */
function Brand() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="grid size-14 place-items-center rounded-[18px] bg-gradient-to-br from-accent to-accent-strong text-accent-ink">
        <Mail size={26} />
      </div>
      <div className="text-center">
        <div className="text-[19px] font-extrabold tracking-tight">MailRiz</div>
        <div className="text-[11px] font-bold tracking-widest text-text-faint uppercase">
          Private Inbox
        </div>
      </div>
    </div>
  );
}

function ThemeToggle({ theme }: { theme: Theme }) {
  return (
    <button
      onClick={theme.toggle}
      className={clsx(ICON_BUTTON, 'absolute top-5 right-5')}
      title={theme.dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme.dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

function Splash({ theme }: { theme: Theme }) {
  return (
    <div className="relative grid min-h-screen place-items-center bg-bg text-text">
      <ThemeToggle theme={theme} />
      <div className="flex flex-col items-center gap-4">
        <Brand />
        <div className="text-[13.5px] text-text-faint">Loading…</div>
      </div>
    </div>
  );
}

/** Session-mode sign-in. The worker sets an HttpOnly cookie, so on success we
 *  only have to let the queries run again — there's no token to hold onto. */
function LoginScreen({ theme }: { theme: Theme }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const qc = useQueryClient();

  const login = useMutation({
    mutationFn: () => api.post('/api/login', { email, password }),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries();
    },
    onError: (e: Error) => setError(e.message),
  });

  const field =
    'mt-1.5 w-full rounded-control border border-border bg-surface-2 px-3 py-2.5 text-[14px] text-text ' +
    'placeholder:text-text-faint transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.isPending) login.mutate();
  };

  return (
    <div className="relative grid min-h-screen place-items-center bg-bg p-4 text-text">
      <ThemeToggle theme={theme} />

      <form
        onSubmit={submit}
        className="w-[380px] max-w-full rounded-card border border-border bg-surface p-7 shadow-[var(--shadow)]"
      >
        <Brand />

        <div className="mt-7">
          <label htmlFor="login-email" className="text-[12.5px] font-semibold text-text-dim">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={field}
          />
        </div>

        <div className="mt-4">
          <label htmlFor="login-password" className="text-[12.5px] font-semibold text-text-dim">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={field}
          />
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 text-[13.5px] text-danger">
            <AlertTriangle size={15} className="mt-px shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={login.isPending || !email || !password}
          className="mt-6 w-full rounded-control bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition hover:bg-accent-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- polling

function usePolling(fn: () => void, intervalMs: number) {
  const [tick, setTick] = useState(0);
  useQuery({
    queryKey: ['poll', tick],
    queryFn: async () => {
      await new Promise((r) => setTimeout(r, intervalMs));
      fn();
      return tick;
    },
  });
}

// ---------------------------------------------------------------- sidebar

function SectionLabel({ icon: Icon, children }: { icon: any; children: React.ReactNode }) {
  return (
    <div className="mt-6 mb-1.5 flex items-center gap-1.5 px-3 text-[11px] font-bold tracking-widest text-text-faint uppercase">
      <Icon size={12} /> {children}
    </div>
  );
}

function Sidebar(props: {
  open: boolean; close: () => void;
  view: EmailView;
  aliasId: string | null; labelId: string | null;
  aliases?: Alias[]; labels?: Label[];
  onPickAlias: (id: string) => void;
  onPickLabel: (id: string) => void;
  onNewAlias: () => void;
  me?: MeResponse;
}) {
  const navItem =
    'flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-[14.5px] transition ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

  return (
    <aside
      className={clsx(
        'fixed inset-y-0 left-0 z-50 flex w-[280px] shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200',
        'lg:static lg:translate-x-0',
        props.open ? 'translate-x-0' : '-translate-x-full'
      )}
    >
      <div className="flex items-center gap-2.5 p-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-accent to-accent-strong text-accent-ink">
          <Mail size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-extrabold tracking-tight">MailRiz</div>
          <div className="truncate text-[11px] font-bold tracking-widest text-text-faint uppercase">
            Private Inbox
          </div>
        </div>
        <button onClick={props.close} className={clsx(ICON_BUTTON, 'lg:hidden')} title="Close menu">
          <X size={16} />
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={props.onNewAlias}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-3 py-2.5 text-[14px] font-semibold text-accent-ink transition hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Plus size={16} /> New Alias
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {props.labels && props.labels.length > 0 && (
          <>
            <SectionLabel icon={Tag}>Labels</SectionLabel>
            {props.labels.map((l) => (
              <button
                key={l.id}
                onClick={() => props.onPickLabel(l.id)}
                className={clsx(
                  navItem,
                  props.labelId === l.id
                    ? 'bg-nav-surface font-semibold text-accent-strong'
                    : 'text-text-dim hover:bg-surface-2 hover:text-text'
                )}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: l.color }} />
                <span className="truncate">{l.name}</span>
              </button>
            ))}
          </>
        )}

        {props.aliases && props.aliases.length > 0 && (
          <>
            <SectionLabel icon={Mail}>Aliases</SectionLabel>
            {props.aliases.map((a) => (
              <button
                key={a.id}
                onClick={() => props.onPickAlias(a.id)}
                className={clsx(
                  navItem,
                  'justify-between',
                  props.aliasId === a.id
                    ? 'bg-nav-surface font-semibold text-accent-strong'
                    : 'text-text-dim hover:bg-surface-2 hover:text-text'
                )}
              >
                <span className="truncate">@{a.local_part}</span>
                {!a.is_enabled ? (
                  <span className="shrink-0 rounded-pill bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-text-faint">
                    off
                  </span>
                ) : a.is_auto ? (
                  /* Created by the catch-all on first delivery, not by hand —
                     worth marking so an unfamiliar address is explicable. */
                  <span
                    title="Created automatically when mail first arrived"
                    className="shrink-0 rounded-pill bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-text-faint"
                  >
                    auto
                  </span>
                ) : null}
              </button>
            ))}
          </>
        )}
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex w-full items-center gap-3 rounded-[12px] p-1.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-[12px] font-bold text-text-dim">
            {props.me ? initials(props.me.email) : '·'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{props.me?.email || '…'}</div>
            <div className="truncate text-[11.5px] text-text-faint">{props.me?.domain || ''}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- topbar

function Topbar(props: {
  scope: string;
  q: string; setQ: (s: string) => void;
  onRefresh: () => void;
  onMenu: () => void;
  dark: boolean; toggleTheme: () => void;
}) {
  return (
    <div className="sticky top-0 z-30 flex h-[66px] shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur sm:px-6">
      <button onClick={props.onMenu} className={clsx(ICON_BUTTON, 'lg:hidden')} title="Open menu">
        <Menu size={18} />
      </button>

      <div className="hidden min-w-0 sm:block">
        <div className="truncate text-[12px] text-text-faint">MailRiz / {props.scope}</div>
        <div className="truncate text-[15px] font-bold">Mail</div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-faint"
          />
          <input
            value={props.q}
            onChange={(e) => props.setQ(e.target.value)}
            placeholder="Search mail…"
            className={clsx(
              CONTROL,
              'h-[38px] w-[180px] pr-3 pl-9 text-[13px] text-text placeholder:text-text-faint sm:w-[260px]'
            )}
          />
        </div>
        <button onClick={props.onRefresh} className={ICON_BUTTON} title="Refresh">
          <RefreshCw size={16} />
        </button>
        <button
          onClick={props.toggleTheme}
          className={ICON_BUTTON}
          title={props.dark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {props.dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- folder rail

function FolderRail(props: {
  view: EmailView;
  scoped: boolean;
  unread: number;
  hasMore: boolean;
  onPick: (v: EmailView) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-3 lg:w-[196px] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:border-r lg:border-b-0">
      {VIEWS.map((v) => {
        const Icon = v.icon;
        const active = props.view === v.id && !props.scoped;
        return (
          <button
            key={v.id}
            onClick={() => props.onPick(v.id)}
            className={clsx(
              'flex shrink-0 items-center gap-3 rounded-[12px] px-3 py-2.5 text-[14.5px] transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              active
                ? 'bg-nav-surface font-semibold text-accent-strong'
                : 'text-text-dim hover:bg-surface-2 hover:text-text'
            )}
          >
            <Icon size={16} className="shrink-0" />
            {v.label}
            {/* Only the open folder has a count we can honestly show — it
                counts what's loaded, so "+" marks that more pages exist. */}
            {active && props.unread > 0 && (
              <span className="ml-auto rounded-pill bg-nav-surface px-2 py-0.5 text-[11px] font-bold text-accent-strong">
                {props.unread}{props.hasMore ? '+' : ''}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- email list

function EmailList(props: {
  emails: EmailSummary[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  loadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
}) {
  if (props.isLoading && props.emails.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-[14px] text-text-faint">
        Loading…
      </div>
    );
  }

  if (props.emails.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-text-faint">
        <MailOpen size={36} className="opacity-40" />
        <div className="text-[14px]">No emails</div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {props.emails.map((e) => (
        <button
          key={e.id}
          onClick={() => props.setSelectedId(e.id)}
          className={clsx(
            'flex w-full flex-col gap-0.5 border-b border-border-soft px-4 py-3 text-left transition last:border-0',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset',
            props.selectedId === e.id ? 'bg-nav-surface/60' : 'hover:bg-surface-2'
          )}
        >
          <div className="flex w-full items-center gap-2">
            {!e.is_read && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
            <span
              className={clsx(
                'truncate text-[14px]',
                e.is_read ? 'text-text-dim' : 'font-bold text-text'
              )}
            >
              {e.from_name || e.from_address}
            </span>
            <span className="ml-auto shrink-0 text-[12px] text-text-faint">
              {timeAgo(e.received_at)}
            </span>
            {e.has_attachments ? (
              <Paperclip size={12} className="shrink-0 text-text-faint" />
            ) : null}
            {e.is_starred ? (
              <Star size={13} className="shrink-0 fill-warn text-warn" />
            ) : null}
          </div>

          <div
            className={clsx(
              'w-full truncate text-[14px]',
              e.is_read ? 'text-text-dim' : 'font-semibold text-text'
            )}
          >
            {e.subject || '(no subject)'}
          </div>

          <div className="w-full truncate text-[13px] text-text-faint">{e.snippet}</div>
        </button>
      ))}

      {props.hasMore && (
        <div className="p-3 text-center">
          <button
            onClick={props.loadMore}
            className="rounded-control px-3 py-1.5 text-[13.5px] font-semibold text-accent-strong transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reading pane

function ReadingPane({ emailId, onBack }: { emailId: string; onBack: () => void }) {
  const { data, isLoading } = useQuery<EmailDetail>({
    queryKey: ['email', emailId],
    queryFn: () => api.get(`/api/emails/${emailId}`),
  });

  const qc = useQueryClient();
  const [showImages, setShowImages] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/emails/${emailId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['emails'] });
      // Without this the open message keeps its pre-mutation flags, so the
      // next toggle sends a stale value and appears to do nothing.
      qc.invalidateQueries({ queryKey: ['email', emailId] });
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-[14px] text-text-faint">
        Loading…
      </div>
    );
  }

  const toggle = (field: 'is_starred' | 'is_archived' | 'is_trashed' | 'is_read') => {
    mutate.mutate({ [field]: data[field] ? 0 : 1 });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* header */}
      <div className="shrink-0 border-b border-border p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <button onClick={onBack} className={clsx(ICON_BUTTON, 'xl:hidden')} title="Back to list">
              <ChevronLeft size={18} />
            </button>
            <h2 className="min-w-0 pt-1 text-[19px] leading-snug font-bold break-words">
              {data.subject || '(no subject)'}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconBtn title="Star" active={!!data.is_starred} onClick={() => toggle('is_starred')}>
              <Star size={16} className={data.is_starred ? 'fill-warn text-warn' : ''} />
            </IconBtn>
            <IconBtn title="Archive" active={!!data.is_archived} onClick={() => toggle('is_archived')}>
              <Archive size={16} />
            </IconBtn>
            <IconBtn title="Trash" active={!!data.is_trashed} onClick={() => toggle('is_trashed')}>
              <Trash2 size={16} />
            </IconBtn>
            <IconBtn title="Mark unread" onClick={() => toggle('is_read')}>
              <Mail size={16} />
            </IconBtn>
            <a
              href={`/api/emails/${emailId}/raw`}
              target="_blank"
              rel="noreferrer"
              title="Download .eml"
              className="grid size-9 place-items-center rounded-[10px] text-text-dim transition hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <FileText size={16} />
            </a>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3 border-b border-border-soft pb-4">
          <div
            className={clsx(
              'grid size-11 shrink-0 place-items-center rounded-full text-[13px] font-bold',
              avatarColor(data.from_address)
            )}
          >
            {initials(data.from_name || data.from_address)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-semibold">
              {data.from_name || data.from_address}
            </div>
            <div className="truncate text-[12.5px] text-text-faint">
              {data.from_address} → {data.to_address}
            </div>
          </div>
          <span className="shrink-0 text-[12.5px] text-text-faint">
            {new Date(data.received_at * 1000).toLocaleString()}
          </span>
        </div>

        {data.attachments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {data.attachments.map((a) => (
              <a
                key={a.id}
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-text transition hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Paperclip size={13} className="text-text-dim" /> {a.filename}
                <span className="font-normal text-text-faint">({formatSize(a.size_bytes)})</span>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {data.body_text && (
          <pre className="mb-4 font-sans text-[14.5px] leading-relaxed whitespace-pre-wrap text-text">
            {data.body_text}
          </pre>
        )}

        {showImages ? (
          <iframe
            key={iframeKey}
            src={`/api/emails/${emailId}/html`}
            className="email-frame"
            sandbox="allow-same-origin"
            title="Email HTML"
          />
        ) : data.html_r2_key ? (
          <div className="flex flex-wrap items-center gap-3 rounded-control border border-border bg-surface-2 p-4 text-[13.5px] text-text-dim">
            <AlertTriangle size={16} className="shrink-0 text-warn" />
            <span className="min-w-0 flex-1">
              This email contains external images. They're blocked for your privacy.
            </span>
            <button
              onClick={() => { setShowImages(true); setIframeKey((k) => k + 1); }}
              className="rounded-[10px] bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink transition hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Show images
            </button>
          </div>
        ) : null}

        {!data.body_text && !data.html_r2_key && (
          <div className="text-[14px] text-text-faint">No content.</div>
        )}
      </div>
    </div>
  );
}

function IconBtn(props: { title: string; active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      className={clsx(
        'grid size-9 place-items-center rounded-[10px] transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        props.active
          ? 'bg-nav-surface text-accent-strong'
          : 'text-text-dim hover:bg-surface-2 hover:text-text'
      )}
    >
      {props.children}
    </button>
  );
}

function EmptyPane() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-text-faint">
      <Mail size={44} className="opacity-30" />
      <div className="text-[14px]">Select an email to read</div>
    </div>
  );
}

// ---------------------------------------------------------------- new alias modal

function NewAliasModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'random' | 'custom'>('random');
  const [prefix, setPrefix] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();

  const field =
    'mt-1.5 w-full rounded-control border border-border bg-surface-2 px-3 py-2 text-[14px] text-text ' +
    'placeholder:text-text-faint transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

  const create = useMutation({
    mutationFn: async (body: CreateAliasInput) => {
      const a = await api.post<Alias>('/api/aliases', body);
      return a;
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['aliases'] });
      navigator.clipboard?.writeText(`${a.local_part}@${a.domain}`).catch(() => {});
      setCopied(true);
      setTimeout(() => { setCopied(false); onClose(); }, 1200);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-full rounded-card border border-border bg-surface p-6 shadow-[var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-[17px] font-bold tracking-tight">New Alias</h3>
          <button
            onClick={onClose}
            className="grid size-9 place-items-center rounded-[10px] text-text-dim transition hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mb-5 flex gap-2">
          {(['random', 'custom'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                'flex-1 rounded-control border px-3 py-2 text-[14px] capitalize transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                mode === m
                  ? 'border-accent bg-nav-surface font-semibold text-accent-strong'
                  : 'border-border bg-surface-2 text-text-dim hover:bg-surface-3 hover:text-text'
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === 'custom' ? (
          <div className="mb-4">
            <label className="text-[12.5px] font-semibold text-text-dim">Local part</label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="newsletter"
              className={field}
            />
            <p className="mt-1.5 text-[11.5px] text-text-faint">[a-z0-9._-], max 64 chars</p>
          </div>
        ) : (
          <div className="mb-4">
            <label className="text-[12.5px] font-semibold text-text-dim">Prefix (optional)</label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="news"
              className={field}
            />
            <p className="mt-1.5 text-[11.5px] text-text-faint">
              Random ={' '}
              <code className="rounded-[6px] border border-border bg-surface px-1.5 text-[11px] font-semibold">
                prefix-4hex
              </code>
            </p>
          </div>
        )}

        <div className="mb-4">
          <label className="text-[12.5px] font-semibold text-text-dim">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Newsletters"
            className={field}
          />
        </div>

        <div className="mb-5">
          <label className="text-[12.5px] font-semibold text-text-dim">Note</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Where this is used"
            className={field}
          />
        </div>

        {error && <div className="mb-4 text-[13.5px] text-danger">{error}</div>}
        {copied && (
          <div className="mb-4 flex items-center gap-1.5 text-[13.5px] text-ok">
            <Check size={14} /> Copied to clipboard
          </div>
        )}

        <button
          onClick={() => create.mutate({ mode, customPrefix: prefix, label, note })}
          disabled={create.isPending}
          className="w-full rounded-control bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition hover:bg-accent-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {create.isPending ? 'Creating…' : 'Create Alias'}
        </button>
      </div>
    </div>
  );
}
