import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { boundsForPeriod, formatYmd, todayYmd } from '../format';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CalendarIcon, CheckIcon, ChevronRightIcon } from 'lucide-react';

const PRESETS = [
  { value: 'last_12_months', label: 'Last 12 months' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'today', label: 'Today' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'year_to_date', label: 'Year to date' },
  { value: 'all_time', label: 'All time' },
] as const;

export interface RangeValue {
  period: string;
  start: string;
  end: string;
}

function parseYmd(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

function cloneRange(value: RangeValue): RangeValue {
  return { period: value.period, start: value.start, end: value.end };
}

function presetLabel(period: string): string | undefined {
  return PRESETS.find((item) => item.value === period)?.label;
}

function displayBounds(value: RangeValue, today: string): { start: string; end: string } {
  if (value.period === 'custom' && value.start && value.end) {
    return { start: value.start, end: value.end };
  }
  if (value.period === 'all_time') return { start: '', end: today };
  return boundsForPeriod(value.period === 'custom' ? 'last_30_days' : value.period);
}

function triggerText(value: RangeValue): string {
  const named = presetLabel(value.period);
  if (named) return named;
  const from = parseYmd(value.start);
  const to = parseYmd(value.end);
  if (from && to) {
    if (from.getTime() === to.getTime()) return format(from, 'MMM d, yyyy');
    return `${format(from, 'MMM d, yyyy')} – ${format(to, 'MMM d, yyyy')}`;
  }
  return 'Custom';
}

function timezoneHint(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  const city = zone.split('/').pop()?.replaceAll('_', ' ') ?? zone;
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `${city} (GMT${sign}${hours}:${minutes})`;
}

function monthFor(value: RangeValue, today: string): Date {
  const bounds = displayBounds(value, today);
  const from = parseYmd(bounds.start);
  const to = parseYmd(bounds.end) ?? parseYmd(today) ?? new Date();
  if (!from) return new Date(to.getFullYear(), to.getMonth() - 1, 1);
  const span = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  return span <= 1 ? from : new Date(to.getFullYear(), to.getMonth() - 1, 1);
}

const itemClass =
  'relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground';

export function RangeControl({
  value,
  disabled,
  disabledTitle,
  onChange,
}: {
  value: RangeValue;
  disabled?: boolean;
  disabledTitle?: string;
  onChange: (next: RangeValue) => void;
}) {
  const today = todayYmd();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [draft, setDraft] = useState<RangeValue>(() => cloneRange(value));
  const [month, setMonth] = useState<Date>(() => monthFor(value, today));

  const shown = useMemo(() => displayBounds(draft, today), [draft, today]);
  const selected: DateRange | undefined = useMemo(() => {
    const from = parseYmd(shown.start);
    const to = parseYmd(shown.end);
    if (!from) return undefined;
    return { from, to: to ?? from };
  }, [shown]);

  const canApply = touched && Boolean(draft.start && draft.end);

  const beginDraft = () => {
    const bounds = displayBounds(value, today);
    const next =
      value.period === 'custom'
        ? cloneRange(value)
        : { period: 'custom', start: bounds.start, end: bounds.end };
    setDraft(next);
    setMonth(monthFor(next, today));
    setTouched(false);
  };

  const setOpenSafe = (next: boolean) => {
    if (disabled) return;
    if (next) {
      beginDraft();
      setCustomOpen(value.period === 'custom');
    } else {
      setCustomOpen(false);
    }
    setOpen(next);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenSafe(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenSafe(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, disabled, value]);

  const choosePreset = (period: string) => {
    onChange({ period, start: '', end: '' });
    setOpenSafe(false);
  };

  const chooseRange = (next: DateRange | undefined) => {
    if (!next?.from) return;
    const start = formatYmd(next.from);
    const end = formatYmd(next.to ?? next.from);
    setDraft({ period: 'custom', start, end: start > end ? start : end });
    setTouched(true);
  };

  const editBound = (key: 'start' | 'end', next: string) => {
    const bounds = displayBounds(draft, today);
    let start = key === 'start' ? next : bounds.start;
    let end = key === 'end' ? next : bounds.end;
    if (start && end && start > end) {
      if (key === 'start') end = start;
      else start = end;
    }
    setDraft({ period: 'custom', start, end });
    setTouched(true);
  };

  const apply = () => {
    if (!canApply) return;
    onChange(cloneRange(draft));
    setOpenSafe(false);
  };

  return (
    <div ref={rootRef} className="control relative z-30" title={disabledTitle}>
      <Label>Range</Label>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        className="h-9 w-[220px] justify-start font-normal"
        onClick={() => setOpenSafe(!open)}
      >
        <CalendarIcon />
        <span className="truncate">{triggerText(value)}</span>
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-[calc(100%+4px)] left-0 z-50 flex w-max overflow-visible rounded-md border border-border bg-[var(--surface-1)] text-[var(--text-primary)] shadow-md"
        >
          <div className="w-56 p-1">
            {PRESETS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="menuitem"
                className={itemClass}
                onMouseEnter={() => setCustomOpen(false)}
                onClick={() => choosePreset(item.value)}
              >
                <span className="flex-1">{item.label}</span>
                {value.period === item.value ? <CheckIcon className="size-4" /> : null}
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              className={itemClass}
              onMouseEnter={() => setCustomOpen(true)}
              onClick={() => setCustomOpen(true)}
            >
              <span className="flex-1">Custom</span>
              {value.period === 'custom' ? <CheckIcon className="size-4" /> : null}
              <ChevronRightIcon className="size-4 text-muted-foreground" />
            </button>
          </div>
          {customOpen ? (
            <div className="flex w-max flex-col gap-3 border-l p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label className="text-muted-foreground">Starting</Label>
                  <Input
                    type="date"
                    className="min-w-0"
                    value={shown.start}
                    max={shown.end || today}
                    onChange={(event) => editBound('start', event.target.value)}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label className="text-muted-foreground">Ending</Label>
                  <Input
                    type="date"
                    className="min-w-0"
                    value={shown.end}
                    min={shown.start}
                    max={today}
                    onChange={(event) => editBound('end', event.target.value)}
                  />
                </div>
              </div>
              <Calendar
                mode="range"
                selected={selected}
                onSelect={chooseRange}
                numberOfMonths={2}
                month={month}
                onMonthChange={setMonth}
                disabled={{ after: new Date() }}
                className="w-max p-0 [--cell-size:--spacing(8)]"
                classNames={{
                  months: 'relative flex flex-row gap-4',
                  month: 'flex w-fit flex-col gap-4',
                }}
              />
              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-muted-foreground">{timezoneHint()}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpenSafe(false)}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" disabled={!canApply} onClick={apply}>
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
