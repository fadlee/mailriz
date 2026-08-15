import { useMemo, useState } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Alias, EmailSummary, EmailDetail, EmailListResponse,
  EmailView, Label, MeResponse, BulkAction, CreateAliasInput,
} from '@mailriz/shared';
import { api } from './lib/api';
import { timeAgo, formatSize, initials, avatarColor } from './lib/format';
import {
  Inbox, Star, Archive, Trash2, Tag, Plus, Search, Mail, MailOpen,
  RefreshCw, Paperclip, X, Check, Copy, ExternalLink, FileText, MoreHorizontal,
  Sun, Moon, AlertTriangle, Download, ChevronDown,
} from 'lucide-react';

// ---------------------------------------------------------------- helpers

const VIEWS: { id: EmailView; label: string; icon: any }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archived', label: 'Archived', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

// ---------------------------------------------------------------- hooks

function useMe() {
  return useQuery<MeResponse>({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
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

// ---------------------------------------------------------------- main app

export default function App() {
  const [view, setView] = useState<EmailView>('inbox');
  const [aliasId, setAliasId] = useState<string | null>(null);
  const [labelId, setLabelId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dark, setDark] = useState(true);
  const [showNewAlias, setShowNewAlias] = useState(false);

  const me = useMe();
  const aliases = useAliases();
  const labels = useLabels();
  const emails = useEmails(view, aliasId, labelId, q);

  // Poll every 25s + on focus.
  usePolling(emails.refetch, 25_000);

  const selectedEmail = emails.emails.find((e) => e.id === selectedId) || null;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-slate-200">
      {/* Sidebar */}
      <Sidebar
        view={view}
        setView={setView}
        aliasId={aliasId}
        setAliasId={setAliasId}
        labelId={labelId}
        setLabelId={setLabelId}
        onNewAlias={() => setShowNewAlias(true)}
        me={me.data}
        dark={dark}
        setDark={setDark}
      />

      {/* List */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-slate-800">
        <ListHeader
          view={view}
          q={q}
          setQ={setQ}
          onRefresh={emails.refetch}
          count={emails.emails.length}
        />
        <EmailList
          emails={emails.emails}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          loadMore={emails.loadMore}
          hasMore={emails.next !== null}
          isLoading={emails.isLoading}
        />
      </div>

      {/* Reading pane */}
      <div className="w-[42%] min-w-[380px] border-l border-slate-800 hidden lg:flex flex-col">
        {selectedEmail ? (
          <ReadingPane emailId={selectedEmail.id} />
        ) : (
          <EmptyPane />
        )}
      </div>

      {showNewAlias && (
        <NewAliasModal onClose={() => setShowNewAlias(false)} />
      )}
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

function Sidebar(props: {
  view: EmailView; setView: (v: EmailView) => void;
  aliasId: string | null; setAliasId: (v: string | null) => void;
  labelId: string | null; setLabelId: (v: string | null) => void;
  onNewAlias: () => void;
  me?: MeResponse;
  dark: boolean; setDark: (b: boolean) => void;
}) {
  const aliases = useAliases();
  const labels = useLabels();

  return (
    <aside className="w-56 shrink-0 border-r border-slate-800 flex flex-col bg-slate-900/40">
      <div className="p-4 flex items-center justify-between">
        <div className="font-bold text-lg tracking-tight text-amber-400">MailRiz</div>
        <button onClick={() => props.setDark(!props.dark)} className="text-slate-400 hover:text-slate-200">
          {props.dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>

      <button
        onClick={props.onNewAlias}
        className="mx-3 mb-3 flex items-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium px-3 py-2 text-sm transition-colors"
      >
        <Plus size={16} /> New Alias
      </button>

      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = props.view === v.id && !props.aliasId && !props.labelId;
          return (
            <button
              key={v.id}
              onClick={() => { props.setView(v.id); props.setAliasId(null); props.setLabelId(null); }}
              className={`w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                active ? 'bg-slate-800 text-amber-300' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <Icon size={16} /> {v.label}
            </button>
          );
        })}

        {labels.data && labels.data.length > 0 && (
          <div className="mt-4 mb-1 px-3 text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Tag size={12} /> Labels
          </div>
        )}
        {labels.data?.map((l) => (
          <button
            key={l.id}
            onClick={() => { props.setLabelId(l.id); props.setAliasId(null); }}
            className={`w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
              props.labelId === l.id ? 'bg-slate-800 text-amber-300' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: l.color }} />
            {l.name}
          </button>
        ))}

        {aliases.data && aliases.data.length > 0 && (
          <div className="mt-4 mb-1 px-3 text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Mail size={12} /> Aliases
          </div>
        )}
        {aliases.data?.map((a) => (
          <button
            key={a.id}
            onClick={() => { props.setAliasId(a.id); props.setLabelId(null); }}
            className={`w-full flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors ${
              props.aliasId === a.id ? 'bg-slate-800 text-amber-300' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <span className="truncate">@{a.local_part}</span>
            {!a.is_enabled && <span className="text-slate-600 text-xs">off</span>}
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-800 text-xs text-slate-500">
        {props.me?.email || '…'}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- list header

function ListHeader(props: {
  view: EmailView; q: string; setQ: (s: string) => void; onRefresh: () => void; count: number;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
      <div className="relative flex-1">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={props.q}
          onChange={(e) => props.setQ(e.target.value)}
          placeholder="Search mail…"
          className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-sm placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        />
      </div>
      <button onClick={props.onRefresh} className="text-slate-400 hover:text-slate-200" title="Refresh">
        <RefreshCw size={16} />
      </button>
      <span className="text-xs text-slate-500 w-16 text-right">{props.count} mails</span>
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
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (props.isLoading && props.emails.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Loading…</div>;
  }

  if (props.emails.length === 0) {
    return <div className="flex-1 flex flex-col items-center justify-center text-slate-600 gap-2">
      <MailOpen size={40} className="opacity-40" />
      <div className="text-sm">No emails</div>
    </div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {props.emails.map((e) => (
        <div
          key={e.id}
          onClick={() => props.setSelectedId(e.id)}
          className={`group flex items-start gap-3 px-3 py-2.5 border-b border-slate-800/60 cursor-pointer transition-colors ${
            props.selectedId === e.id ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
          }`}
        >
          <input
            type="checkbox"
            checked={selected.has(e.id)}
            onClick={(ev) => { ev.stopPropagation(); toggleSelect(e.id); }}
            className="mt-1 accent-amber-500"
          />
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 ${avatarColor(e.from_address)}`}>
            {initials(e.from_name || e.from_address)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`truncate text-sm ${e.is_read ? 'text-slate-300' : 'text-white font-semibold'}`}>
                {e.from_name || e.from_address}
              </span>
              <span className="text-[11px] text-slate-500 shrink-0">{timeAgo(e.received_at)}</span>
            </div>
            <div className={`truncate text-sm ${e.is_read ? 'text-slate-400' : 'text-slate-200'}`}>
              {e.subject || '(no subject)'}
            </div>
            <div className="flex items-center gap-2">
              <span className="truncate text-xs text-slate-500">{e.snippet}</span>
              {e.has_attachments ? <Paperclip size={12} className="text-slate-500 shrink-0" /> : null}
              {e.is_starred ? <Star size={12} className="text-amber-400 shrink-0 fill-amber-400" /> : null}
            </div>
          </div>
        </div>
      ))}

      {props.hasMore && (
        <div className="p-3 text-center">
          <button onClick={props.loadMore} className="text-sm text-amber-400 hover:text-amber-300">
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reading pane

function ReadingPane({ emailId }: { emailId: string }) {
  const { data, isLoading } = useQuery<EmailDetail>({
    queryKey: ['email', emailId],
    queryFn: () => api.get(`/api/emails/${emailId}`),
  });

  const qc = useQueryClient();
  const [showImages, setShowImages] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/emails/${emailId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['emails'] }),
  });

  if (isLoading || !data) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Loading…</div>;
  }

  const toggle = (field: 'is_starred' | 'is_archived' | 'is_trashed' | 'is_read') => {
    mutate.mutate({ [field]: data[field] ? 0 : 1 });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* header */}
      <div className="px-5 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-100 break-words">
            {data.subject || '(no subject)'}
          </h2>
          <div className="flex items-center gap-1 shrink-0">
            <IconBtn title="Star" active={!!data.is_starred} onClick={() => toggle('is_starred')}>
              <Star size={15} className={data.is_starred ? 'fill-amber-400 text-amber-400' : ''} />
            </IconBtn>
            <IconBtn title="Archive" active={!!data.is_archived} onClick={() => toggle('is_archived')}>
              <Archive size={15} />
            </IconBtn>
            <IconBtn title="Trash" active={!!data.is_trashed} onClick={() => toggle('is_trashed')}>
              <Trash2 size={15} />
            </IconBtn>
            <IconBtn title="Mark unread" onClick={() => toggle('is_read')}>
              <Mail size={15} />
            </IconBtn>
            <a href={`/api/emails/${emailId}/raw`} target="_blank" rel="noreferrer" title="Download .eml">
              <IconBtn title="Raw">
                <FileText size={15} />
              </IconBtn>
            </a>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2 text-sm">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-white ${avatarColor(data.from_address)}`}>
            {initials(data.from_name || data.from_address)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-slate-200">{data.from_name || data.from_address}</div>
            <div className="truncate text-xs text-slate-500">
              {data.from_address} → {data.to_address}
              <span className="ml-2">{new Date(data.received_at * 1000).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {data.attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {data.attachments.map((a) => (
              <a
                key={a.id}
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
              >
                <Paperclip size={12} /> {a.filename}
                <span className="text-slate-500">({formatSize(a.size_bytes)})</span>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto p-5">
        {data.body_text && (
          <pre className="whitespace-pre-wrap font-sans text-sm text-slate-300 leading-relaxed mb-4">
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
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-400 flex items-center gap-3">
            <AlertTriangle size={16} className="text-amber-400" />
            <span className="flex-1">This email contains external images. They're blocked for your privacy.</span>
            <button
              onClick={() => { setShowImages(true); setIframeKey((k) => k + 1); }}
              className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-slate-950 hover:bg-amber-400"
            >
              Show images
            </button>
          </div>
        ) : null}

        {!data.body_text && !data.html_r2_key && (
          <div className="text-sm text-slate-500">No content.</div>
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
      className={`p-1.5 rounded-md transition-colors ${
        props.active ? 'text-amber-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
      }`}
    >
      {props.children}
    </button>
  );
}

function EmptyPane() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-slate-600 gap-3">
      <Mail size={48} className="opacity-30" />
      <div className="text-sm">Select an email to read</div>
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="w-[420px] max-w-[92vw] rounded-xl bg-slate-900 border border-slate-700 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-100">New Alias</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200"><X size={18} /></button>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setMode('random')}
            className={`flex-1 rounded-lg px-3 py-2 text-sm border ${
              mode === 'random' ? 'border-amber-500 text-amber-300 bg-amber-500/10' : 'border-slate-700 text-slate-400'
            }`}
          >
            Random
          </button>
          <button
            onClick={() => setMode('custom')}
            className={`flex-1 rounded-lg px-3 py-2 text-sm border ${
              mode === 'custom' ? 'border-amber-500 text-amber-300 bg-amber-500/10' : 'border-slate-700 text-slate-400'
            }`}
          >
            Custom
          </button>
        </div>

        {mode === 'custom' ? (
          <div className="mb-3">
            <label className="text-xs text-slate-400">Local part</label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="newsletter"
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">[a-z0-9._-], max 64 chars</p>
          </div>
        ) : (
          <div className="mb-3">
            <label className="text-xs text-slate-400">Prefix (optional)</label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="news"
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">Random = <code className="text-slate-400">prefix-4hex</code></p>
          </div>
        )}

        <div className="mb-3">
          <label className="text-xs text-slate-400">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Newsletters"
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>

        <div className="mb-4">
          <label className="text-xs text-slate-400">Note</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Where this is used"
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>

        {error && <div className="mb-3 text-sm text-rose-400">{error}</div>}
        {copied && (
          <div className="mb-3 text-sm text-emerald-400 flex items-center gap-1.5">
            <Check size={14} /> Copied to clipboard
          </div>
        )}

        <button
          onClick={() => create.mutate({ mode, customPrefix: prefix, label, note })}
          disabled={create.isPending}
          className="w-full rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-medium py-2 text-sm"
        >
          {create.isPending ? 'Creating…' : 'Create Alias'}
        </button>
      </div>
    </div>
  );
}
