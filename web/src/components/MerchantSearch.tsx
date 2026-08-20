import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as InputKeyEvent, type MouseEvent as DialogMouseEvent, type ReactNode } from 'react';
import { searchMerchants, type CustomerSummary } from '../api';
import { formatValue } from '../format';
import { StatusPill } from './Customers';

/**
 * Cmd/Ctrl+K from anywhere in the dashboard.
 *
 * A native dialog, same as the review linker, because the focus trap and
 * Escape come with it. The list is a combobox: typing filters, arrows move,
 * Enter opens the merchant. Results come from the server rather than a
 * downloaded population — tens of thousands of shops — and the previous
 * response stays on screen so a slower keystroke never blanks the list.
 */

const LIMIT = 12;
const DEBOUNCE_MS = 50;

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

function isSearchHotkey(event: KeyboardEvent): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
}

function merchantLabel(row: CustomerSummary): string {
  return row.name ?? row.domain ?? row.shopId;
}

function matchesQuery(row: CustomerSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    row.shopId.toLowerCase() === needle ||
    (row.name?.toLowerCase().includes(needle) ?? false) ||
    (row.domain?.toLowerCase().includes(needle) ?? false)
  );
}

/** One occurrence, so a name with the query twice is not a highlighter. */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export function MerchantSearch({ appId }: { appId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mac] = useState(isMacPlatform);

  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cache = useRef(new Map<string, { rows: CustomerSummary[]; complete: boolean }>());
  const listId = useId();
  const optionId = `${listId}-option`;

  const cacheKey = useCallback((value: string) => `${appId}::${value.trim().toLowerCase()}`, [appId]);

  const load = useCallback(
    (value: string, signal: AbortSignal): Promise<CustomerSummary[]> => {
      return searchMerchants({ search: value, limit: LIMIT, appId, signal }).then((result) => {
        cache.current.set(cacheKey(value), {
          rows: result.merchants,
          complete: result.merchants.length < LIMIT,
        });
        return result.merchants;
      });
    },
    [appId, cacheKey],
  );

  // Warm the empty query so the first Cmd+K is a paint, not a spinner.
  useEffect(() => {
    const controller = new AbortController();
    load('', controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open]);

  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSearchHotkey(event)) return;
      event.preventDefault();
      if (openRef.current) {
        setOpen(false);
        return;
      }
      setQuery('');
      setActive(0);
      const cached = cache.current.get(cacheKey(''));
      if (cached) setRows(cached.rows);
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cacheKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    const exact = cache.current.get(cacheKey(trimmed));
    if (exact) {
      setRows(exact.rows);
      setActive(0);
      setError(null);
      setLoading(false);
    } else {
      // A longer query is a subset of a shorter complete one, so filter what
      // we already have while the server round-trip is in flight.
      for (const [key, entry] of cache.current) {
        const cachedQuery = key.startsWith(`${appId}::`) ? key.slice(appId.length + 2) : null;
        if (cachedQuery === null) continue;
        if (entry.complete && trimmed.startsWith(cachedQuery)) {
          setRows(entry.rows.filter((row) => matchesQuery(row, trimmed)));
          setActive(0);
          break;
        }
      }
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      load(trimmed, controller.signal)
        .then((merchants) => {
          setRows(merchants);
          setActive(0);
          setError(null);
        })
        .catch((cause: Error) => {
          if (cause.name === 'AbortError') return;
          setError(cause.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, cacheKey, load, appId]);

  useEffect(() => {
    if (!open) return;
    const row = rows[active];
    if (!row) return;
    document.getElementById(`${optionId}-${row.shopId}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, rows, optionId]);

  const openPalette = useCallback(() => {
    setQuery('');
    setActive(0);
    const cached = cache.current.get(cacheKey(''));
    if (cached) setRows(cached.rows);
    setOpen(true);
  }, [cacheKey]);

  const go = useCallback((shopId: string) => {
    setOpen(false);
    window.location.hash = `/customers/${shopId}`;
  }, []);

  const onInputKey = (event: InputKeyEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = rows[active] ?? rows[0];
      if (chosen) go(chosen.shopId);
    }
  };

  const hotkey = mac ? '⌘K' : 'Ctrl+K';
  const activeId = rows[active] ? `${optionId}-${rows[active]!.shopId}` : undefined;
  const currency = useMemo(
    () => rows.find((row) => row.currency)?.currency ?? null,
    [rows],
  );

  const onBackdrop = (event: DialogMouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="search-trigger"
        onClick={openPalette}
        aria-label="Search merchants"
        title={`Search merchants (${hotkey})`}
      >
        <svg viewBox="0 0 22 22" aria-hidden="true" focusable="false">
          <circle cx="9.5" cy="9.5" r="5.5" fill="none" strokeWidth="1.7" />
          <path d="M13.8 13.8L19 19" fill="none" strokeWidth="1.7" />
        </svg>
        <span className="search-trigger-label">Search merchants</span>
        <kbd className="search-hotkey">{hotkey}</kbd>
      </button>

      <dialog
        ref={dialog}
        className="command-palette"
        aria-label="Search merchants"
        onClose={() => setOpen(false)}
        onClick={onBackdrop}
      >
        <div className="command-palette-search">
          <svg viewBox="0 0 22 22" aria-hidden="true" focusable="false">
            <circle cx="9.5" cy="9.5" r="5.5" fill="none" strokeWidth="1.7" />
            <path d="M13.8 13.8L19 19" fill="none" strokeWidth="1.7" />
          </svg>
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            placeholder="Store name, myshopify domain, or shop id"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKey}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {loading ? <span className="command-palette-status">Searching…</span> : null}
        </div>

        {error ? (
          <p className="command-palette-empty" role="alert">
            {error}
          </p>
        ) : null}

        {!error && rows.length === 0 && !loading ? (
          <p className="command-palette-empty">
            {query.trim()
              ? 'Nothing matches that name, domain, or shop id.'
              : 'No merchants yet. Run a sync and try again.'}
          </p>
        ) : null}

        {rows.length > 0 ? (
          <ul id={listId} role="listbox" className="command-palette-list">
            {rows.map((row, index) => (
              <li key={row.shopId} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${optionId}-${row.shopId}`}
                  aria-selected={index === active}
                  className={index === active ? 'command-palette-row active' : 'command-palette-row'}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(row.shopId)}
                >
                  <span className="command-palette-identity">
                    <span className="customer-name">{highlight(merchantLabel(row), query)}</span>
                    <span className="customer-domain">
                      {row.domain && row.domain !== merchantLabel(row)
                        ? highlight(row.domain, query)
                        : row.shopId}
                    </span>
                  </span>
                  <StatusPill status={row.status} />
                  <span className="command-palette-mrr">
                    {formatValue(row.mrr, 'money', row.currency ?? currency)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="command-palette-hint">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </p>
      </dialog>
    </>
  );
}
