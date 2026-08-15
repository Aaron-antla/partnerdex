import { useMemo } from 'react';
import { boundsForPeriod, todayYmd } from '../format';

const PRESETS = [
  { value: 'last_12_months', label: 'Last 12 months' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'today', label: 'Today' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'year_to_date', label: 'Year to date' },
  { value: 'all_time', label: 'All time' },
  { value: 'custom', label: 'Custom' },
] as const;

export interface RangeValue {
  period: string;
  start: string;
  end: string;
}

function shownBounds(value: RangeValue, today: string): { start: string; end: string } {
  if (value.period === 'custom' && value.start && value.end) {
    return { start: value.start, end: value.end };
  }
  if (value.period === 'all_time') return { start: '', end: today };
  return boundsForPeriod(value.period === 'custom' ? 'last_30_days' : value.period);
}

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
  const shown = useMemo(() => shownBounds(value, today), [value, today]);

  const choosePeriod = (period: string) => {
    if (period === 'custom') {
      const bounds = shownBounds(value, today);
      onChange({ period: 'custom', start: bounds.start, end: bounds.end || today });
      return;
    }
    onChange({ period, start: '', end: '' });
  };

  const editBound = (key: 'start' | 'end', next: string) => {
    let start = key === 'start' ? next : shown.start;
    let end = key === 'end' ? next : shown.end;
    if (start && end && start > end) {
      if (key === 'start') end = start;
      else start = end;
    }
    onChange({ period: 'custom', start, end });
  };

  return (
    <div className="control control-range">
      <label htmlFor="period">Range</label>
      <select
        id="period"
        value={PRESETS.some((item) => item.value === value.period) ? value.period : 'custom'}
        disabled={disabled}
        title={disabledTitle}
        onChange={(event) => choosePeriod(event.target.value)}
      >
        {PRESETS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      <div className="range-dates">
        <input
          type="date"
          aria-label="Start date"
          value={shown.start}
          max={shown.end || today}
          disabled={disabled}
          onChange={(event) => editBound('start', event.target.value)}
        />
        <span className="range-dates-sep">–</span>
        <input
          type="date"
          aria-label="End date"
          value={shown.end}
          min={shown.start}
          max={today}
          disabled={disabled}
          onChange={(event) => editBound('end', event.target.value)}
        />
      </div>
    </div>
  );
}
