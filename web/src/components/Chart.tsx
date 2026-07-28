import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricFormat } from '../api';
import { formatBucketDate, formatFullDate, formatValue } from '../format';

/**
 * The plot primitives every card draws with.
 *
 * Grid and axis are drawn in the theme's low-contrast scaffolding roles, so the
 * data reads and the frame recedes — and both follow the surface when the theme
 * flips, since nothing here names a colour directly.
 *
 * A legend is rendered by the card whenever there is more than one series, and
 * those cards also carry a table view: four slots is past the point where colour
 * alone identifies a series, whatever its contrast. A single-series card needs
 * neither — its title names the series.
 */

export interface ChartSeries {
  key: string;
  name: string;
  /** A CSS custom property reference, so the theme swap is automatic. */
  color: string;
}

export type ChartDatum = { date: string } & Record<string, number | string>;

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
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((item) => (
              <th scope="col" key={item.key}>
                {item.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.date}>
              <th scope="row">{formatBucketDate(row.date, interval)}</th>
              {series.map((item) => (
                <td key={item.key}>
                  {formatValue(Number(row[item.key] ?? 0), format, currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function Frame({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <div className="plot" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
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
    <Frame height={height}>
      <AreaChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <Tooltip
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
    <Frame height={height}>
      <BarChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <Tooltip
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
    <Frame height={height}>
      <LineChart data={data} margin={MARGIN}>
        {sharedAxes(format, currency, interval)}
        <Tooltip
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
