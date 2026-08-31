import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricFormat } from '../api';
import { formatBucketDate, formatFullDate, formatValue } from '../format';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The plot primitives every card draws with.
 *
 * Grid and axis are drawn in the theme's low-contrast scaffolding roles, so the
 * data reads and the frame recedes — and both follow the surface when the theme
 * flips, since nothing here names a colour directly.
 *
 * A legend is rendered by the card whenever there is more than one series.
 * Four slots is past the point where colour alone identifies a series; the
 * names sit in the legend, and the card title opens the merchants in the figure
 * when that population is a customer list.
 */

export interface ChartSeries {
  key: string;
  name: string;
  /** A CSS custom property reference, so the theme swap is automatic. */
  color: string;
}

export type ChartDatum = { date: string } & Record<string, number | string>;

function ledgerTone(value: number): string | undefined {
  if (value > 0) return 'var(--delta-up)';
  if (value < 0) return 'var(--delta-down)';
  return undefined;
}

export function DataTable({
  series,
  data,
  format,
  currency,
  interval,
}: {
  series: ChartSeries[];
  data: ChartDatum[];
  format: MetricFormat;
  currency: string | null;
  interval: string;
}) {
  return (
    <Table className="metric-ledger">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="sticky left-0 z-10 bg-[var(--surface-1)]">
            Period
          </TableHead>
          {series.map((item) => (
            <TableHead
              scope="col"
              key={item.key}
              className={cn(
                'text-right',
                item.key === 'net' &&
                  'border-l border-[var(--border)] font-semibold text-[var(--text-primary)]',
              )}
            >
              {item.name}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => (
          <TableRow key={row.date}>
            <TableCell className="sticky left-0 z-10 bg-[var(--surface-1)] font-medium text-[var(--text-primary)]">
              {formatBucketDate(row.date, interval)}
            </TableCell>
            {series.map((item) => {
              const value = Number(row[item.key] ?? 0);
              const isNet = item.key === 'net';
              return (
                <TableCell
                  key={item.key}
                  className={cn(
                    'text-right tabular-nums',
                    isNet && 'border-l border-[var(--border)] font-semibold',
                    value === 0 && 'text-[var(--muted)]',
                  )}
                  style={value === 0 ? undefined : { color: ledgerTone(value) }}
                >
                  {formatValue(value, format, currency)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number;
}

function SeriesTooltip({
  active,
  payload,
  label,
  series,
  format,
  currency,
  showTotal,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  series: ChartSeries[];
  format: MetricFormat;
  currency: string | null;
  showTotal: boolean;
}) {
  if (!active || !payload?.length) return null;

  const total = payload.reduce((sum, entry) => sum + (entry.value ?? 0), 0);

  return (
    <div className="tooltip">
      <div className="tooltip-date">{label ? formatFullDate(label) : ''}</div>
      {payload.map((entry) => {
        const match = series.find((item) => item.key === entry.dataKey);
        if (!match) return null;
        return (
          <div className="tooltip-row" key={match.key}>
            <span className="name">
              <span className="legend-swatch" style={{ background: match.color }} />
              {match.name}
            </span>
            <span className="value">{formatValue(entry.value ?? 0, format, currency)}</span>
          </div>
        );
      })}
      {showTotal && payload.length > 1 ? (
        <div className="tooltip-row total">
          <span className="name">Total</span>
          <span className="value">{formatValue(total, format, currency)}</span>
        </div>
      ) : null}
    </div>
  );
}

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 10 } as const;
const MARGIN = { top: 6, right: 6, bottom: 0, left: 0 } as const;

interface PlotProps {
  data: ChartDatum[];
  series: ChartSeries[];
  format: MetricFormat;
  currency: string | null;
  interval: string;
  /** Cards run short so three fit a row; the breakdown card runs taller. */
  height?: number;
}

function axisFormatter(format: MetricFormat, currency: string | null) {
  return (value: number) => formatValue(value, format, currency, { compact: true });
}

function sharedAxes(format: MetricFormat, currency: string | null, interval: string) {
  return (
    <>
      <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
      <XAxis
        dataKey="date"
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={{ stroke: 'var(--axis)' }}
        tickFormatter={(value: string) => formatBucketDate(value, interval)}
        minTickGap={30}
      />
      <YAxis
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={false}
        width={52}
        tickCount={4}
        tickFormatter={axisFormatter(format, currency)}
      />
    </>
  );
}

function Frame({
  height,
  series,
  children,
}: {
  height: number;
  series: ChartSeries[];
  children: React.ComponentProps<typeof ChartContainer>['children'];
}) {
  const config = Object.fromEntries(
    series.map((item) => [item.key, { label: item.name, color: item.color }]),
  ) satisfies ChartConfig;

  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height }}
      initialDimension={{ width: 320, height }}
    >
      {children}
    </ChartContainer>
  );
}

/** Stacked composition over time — the shape of MRR split by app. */
export function StackedAreaPlot({
  data,
  series,
  format,
  currency,
  interval,
  height = 150,
}: PlotProps) {
  return (
    <Frame height={height} series={series}>
      <AreaChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <ChartTooltip
          cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
          content={<SeriesTooltip series={series} format={format} currency={currency} showTotal />}
        />
        {series.map((item) => (
          <Area
            key={item.key}
            type="monotone"
            dataKey={item.key}
            stackId="stack"
            stroke="var(--surface-1)"
            // A 2px card-coloured edge reads as a gap, so adjacent bands in a
            // stack separate by shape and not only by hue.
            strokeWidth={2}
            fill={item.color}
            fillOpacity={0.9}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </Frame>
  );
}

/** Flow metrics: money or counts that accumulate inside each bucket. */
export function BarPlot({ data, series, format, currency, interval, height = 150 }: PlotProps) {
  return (
    <Frame height={height} series={series}>
      <BarChart data={data} accessibilityLayer margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <ChartTooltip
          cursor={{ fill: 'var(--hover-wash)' }}
          content={<SeriesTooltip series={series} format={format} currency={currency} showTotal />}
        />
        {series.map((item, index) => (
          <Bar
            key={item.key}
            dataKey={item.key}
            stackId="stack"
            fill={item.color}
            stroke="var(--surface-1)"
            strokeWidth={2}
            // Rounded ends belong on the top of the stack only.
            radius={index === series.length - 1 ? [4, 4, 0, 0] : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </Frame>
  );
}

/** Stock metrics and rates: a level read at each point in time. */
export function LinePlot({ data, series, format, currency, interval, height = 150 }: PlotProps) {
  return (
    <Frame height={height} series={series}>
      <LineChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <ChartTooltip
          cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
          content={
            <SeriesTooltip series={series} format={format} currency={currency} showTotal={false} />
          }
        />
        {series.map((item) => (
          <Line
            key={item.key}
            type="monotone"
            dataKey={item.key}
            stroke={item.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </Frame>
  );
}

/** Turns the API's per-series arrays into the row shape Recharts consumes. */
export function useChartData(
  seriesData: Array<{ key: string; data: Array<{ date: string; value: number }> }>,
): ChartDatum[] {
  return useMemo(() => {
    const rows = new Map<string, ChartDatum>();
    for (const series of seriesData) {
      for (const point of series.data) {
        const row = rows.get(point.date) ?? ({ date: point.date } as ChartDatum);
        row[series.key] = point.value;
        rows.set(point.date, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [seriesData]);
}
