import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  Scatter,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchMultipliers, type MultiplierCustomer, type MultipliersReport } from '../api';
import { formatCalendarDate, formatValue } from '../format';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';

/**
 * Two multipliers from *Hidden Multipliers*, on one page.
 *
 * The **profit whale** ranks every customer by what they pay minus what they
 * cost, so the shape says how much of the profit a few customers carry and how
 * much the tail gives back. **Pay vs. usage** is the same population on two
 * axes, with the break-even line drawn in, because the customers worth a
 * conversation are the ones near or under it. The **cancellation ceiling** is
 * the size the business converges on at today's acquisition and churn.
 */

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 10 } as const;

type Filter = 'all' | 'losing' | 'thin' | 'idle' | 'discounted' | 'credits';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'losing', label: 'Losing money' },
  { key: 'thin', label: 'Thin margin' },
  { key: 'idle', label: 'Paying, no usage' },
  { key: 'discounted', label: 'Discounted' },
  { key: 'credits', label: 'Bought credits' },
];

const STATUS_LABEL: Record<MultiplierCustomer['status'], string> = {
  paying: 'Paying',
  trialing: 'Trial',
  free: 'Free',
  uninstalled: 'Uninstalled',
  unmatched: 'Not in Partner API',
};

const PAGE = 50;

const count = (value: number) => formatValue(value, 'count', null);

/** Sub-dollar unit costs need more than cents: $0.045 is not $0.05. */
function unitMoney(value: number, currency: string | null): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency ?? 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

/** Round-number ticks for a square-root axis, which otherwise bunches them at zero. */
const GENERATION_TICKS = [0, 100, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 40_000, 80_000];
const pct = (fraction: number | null, digits = 0) =>
  fraction === null ? '—' : `${(fraction * 100).toFixed(digits)}%`;

function Figure({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="mx-figure">
      <span className="mx-figure-label">{label}</span>
      <span className={`mx-figure-value${tone ? ` ${tone}` : ''}`}>{value}</span>
      {note ? <span className="mx-figure-note">{note}</span> : null}
    </div>
  );
}

function CurveTooltip({
  active,
  payload,
  money,
}: {
  active?: boolean;
  payload?: Array<{ payload?: MultiplierCustomer }>;
  money: (value: number) => string;
}) {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  return (
    <div className="tooltip">
      <div className="tooltip-date">
        #{row.rank} · {row.name ?? row.domain}
      </div>
      <div className="tooltip-row">
        <span className="name">Profit</span>
        <span className="value">{money(row.profit)}</span>
      </div>
      <div className="tooltip-row">
        <span className="name">Cumulative</span>
        <span className="value">{money(row.cumulativeProfit)}</span>
      </div>
    </div>
  );
}

function ScatterTooltip({
  active,
  payload,
  money,
}: {
  active?: boolean;
  payload?: Array<{ payload?: MultiplierCustomer & { x?: number } }>;
  money: (value: number) => string;
}) {
  const row = active ? payload?.find((entry) => entry.payload?.domain)?.payload : undefined;
  if (!row) return null;
  return (
    <div className="tooltip">
      <div className="tooltip-date">{row.name ?? row.domain}</div>
      <div className="tooltip-row">
        <span className="name">Pays / month</span>
        <span className="value">{money(row.paidMrr)}</span>
      </div>
      {row.credits > 0 ? (
        <div className="tooltip-row">
          <span className="name">Credits</span>
          <span className="value">{money(row.credits)}</span>
        </div>
      ) : null}
      <div className="tooltip-row">
        <span className="name">Generations</span>
        <span className="value">{count(row.generations)}</span>
      </div>
      <div className="tooltip-row">
        <span className="name">Profit</span>
        <span className="value">{money(row.profit)}</span>
      </div>
    </div>
  );
}

function band(row: MultiplierCustomer): 'losing' | 'thin' | 'healthy' | 'unpaid' {
  if (row.profit < 0) return 'losing';
  if (row.revenue <= 0) return 'unpaid';
  if (row.margin !== null && row.margin < 0.25) return 'thin';
  return 'healthy';
}

const BAND_COLOR = {
  healthy: 'var(--series-1)',
  thin: 'var(--series-3)',
  losing: 'var(--critical)',
  unpaid: 'var(--muted)',
} as const;

export function Multipliers() {
  const [report, setReport] = useState<MultipliersReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let cancelled = false;
    fetchMultipliers()
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const money = useMemo(
    () => (value: number, compact = false) => formatValue(value, 'money', report?.currency ?? 'USD', { compact }),
    [report?.currency],
  );

  const rows = useMemo(() => {
    const all = report?.customers ?? [];
    switch (filter) {
      case 'losing':
        return [...all].filter((row) => row.profit < 0).reverse();
      case 'thin':
        return all.filter((row) => row.status === 'paying' && row.margin !== null && row.margin < 0.25);
      case 'idle':
        return all.filter((row) => row.status === 'paying' && row.generations === 0);
      case 'discounted':
        return all.filter((row) => row.discounted);
      case 'credits':
        return all.filter((row) => row.credits > 0);
      default:
        return all;
    }
  }, [report, filter]);

  // Shops with usage or revenue; the hundreds of idle free installs sit at the
  // origin and would only hide the shape.
  const scatter = useMemo(
    () =>
      (report?.customers ?? [])
        .filter((row) => row.generations > 0 || row.revenue > 0)
        .map((row) => ({ ...row, x: row.generations, y: row.revenue, fill: BAND_COLOR[band(row)] })),
    [report],
  );

  const maxGenerations = useMemo(() => Math.max(1, ...scatter.map((row) => row.generations)), [scatter]);

  const breakEven = useMemo(() => {
    if (!report) return [];
    const max = maxGenerations;
    const { costPerGeneration, costPerPayingShop } = report.settings;
    return Array.from({ length: 41 }, (_, index) => {
      const x = (max * (index / 40) ** 2);
      return { x, breakEven: x * costPerGeneration + costPerPayingShop };
    });
  }, [report, maxGenerations]);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load Multipliers</h2>
        <p>{error}</p>
      </div>
    );
  }
  if (!report) return <div className="skeleton">Loading Multipliers…</div>;

  const { whale, ceiling, usage, settings } = report;
  const noCosts = settings.costPerGeneration === 0 && settings.costPerPayingShop === 0;
  const peak = report.customers[whale.peakRank - 1];

  return (
    <div className="mx-page">
      {usage.generations === 0 ? (
        <div className="notice warn">
          <h2>No usage collected yet</h2>
          <p>
            Revenue is here, but cost needs Mixpanel. Connect a service account under{' '}
            <a href="#/mixpanel">Settings → Mixpanel</a> and every customer below is priced by what
            they use.
          </p>
        </div>
      ) : null}
      {noCosts ? (
        <div className="notice warn">
          <h2>No costs set</h2>
          <p>
            Every customer reads as pure profit until a cost per generation is set under{' '}
            <a href="#/mixpanel">Settings → Mixpanel</a>.
          </p>
        </div>
      ) : null}

      {/* ------------------------------------------------------- the whale */}
      <h2 className="mx-section">Profit whale</h2>
      <p className="mx-section-blurb">
        Last {report.window.days} days ({formatCalendarDate(report.window.from)} –{' '}
        {formatCalendarDate(report.window.to)}). Revenue is what each shop actually pays a month
        plus any credits bought in the window; cost is {unitMoney(settings.costPerGeneration, report.currency)} per generation plus{' '}
        {money(settings.costPerPayingShop)} per paying shop.
      </p>

      <div className="card full mx-figures">
        <Figure label="Paid MRR" value={money(whale.paidMrr)} note={`${count(whale.makers.count + whale.takers.count)} shops with revenue or usage`} />
        <Figure
          label="Credits"
          value={money(whale.credits)}
          note={`${count(report.customers.filter((row) => row.credits > 0).length)} shops bought one-time credits`}
        />
        <Figure label="Cost to serve" value={money(whale.cost)} note={`${count(usage.generations)} generations`} />
        <Figure
          label="Profit"
          value={money(whale.finalProfit)}
          note={whale.revenue > 0 ? `${pct(whale.finalProfit / whale.revenue)} margin` : undefined}
        />
        <Figure
          label="Whale ratio"
          value={whale.whaleRatio === null ? '—' : `${whale.whaleRatio.toFixed(2)}×`}
          note={`Peak ${money(whale.peakProfit)} at customer #${whale.peakRank}`}
        />
        <Figure
          label="Losing money"
          value={count(whale.takers.count)}
          tone={whale.takers.count > 0 ? 'bad' : undefined}
          note={`${money(whale.takers.profit)} in total`}
        />
      </div>

      <div className="card full">
        <div className="card-head">
          <span className="card-label">Cumulative profit, customers ranked by profit</span>
        </div>
        <p className="card-subtitle">
          The climb is the customers who carry the business; anything after the crest gives profit
          back. Top 20% of customers earn {pct(whale.top20Share)} of the final profit.
        </p>
        <ChartContainer
          config={{ cumulativeProfit: { label: 'Cumulative profit', color: 'var(--series-1)' } }}
          className="aspect-auto w-full"
          style={{ height: 260 }}
          initialDimension={{ width: 800, height: 260 }}
        >
          <ComposedChart data={report.customers} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="rank"
              type="number"
              domain={[1, Math.max(1, report.customers.length)]}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={60}
              tickFormatter={(value: number) => money(value, true)}
            />
            <ChartTooltip content={<CurveTooltip money={money} />} />
            <Area
              type="monotone"
              dataKey="cumulativeProfit"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill="var(--series-1)"
              fillOpacity={0.15}
              isAnimationActive={false}
            />
            <ReferenceLine
              y={whale.finalProfit}
              stroke="var(--axis)"
              strokeDasharray="4 4"
              label={{ value: `Final ${money(whale.finalProfit, true)}`, position: 'insideBottomRight', fill: 'var(--muted)', fontSize: 10 }}
            />
            {peak ? (
              <ReferenceDot
                x={peak.rank}
                y={peak.cumulativeProfit}
                r={4}
                fill="var(--series-1)"
                stroke="var(--surface-1)"
                label={{ value: 'Crest', position: 'top', fill: 'var(--text-secondary)', fontSize: 10 }}
              />
            ) : null}
          </ComposedChart>
        </ChartContainer>
        <p className="footnote">
          {count(whale.makers.count)} profitable · {count(whale.neutral)} break even (free installs with
          no usage) · {count(whale.takers.count)} losing money. Bottom 20% net{' '}
          {money(whale.bottom20Profit)}.
        </p>
      </div>

      <div className="card full">
        <div className="card-head">
          <span className="card-label">What each shop pays against what it uses</span>
        </div>
        <p className="card-subtitle">
          The dashed line is break-even. Shops below it cost more than they pay; heavy users close
          above it are underpriced. {count(whale.payingWithoutUsage)} paying shops had no
          generations at all — they are on the left edge and the likeliest to cancel.
        </p>
        <ChartContainer
          config={{ breakEven: { label: 'Break-even', color: 'var(--critical)' } }}
          className="aspect-auto w-full"
          style={{ height: 320 }}
          initialDimension={{ width: 800, height: 320 }}
        >
          <ComposedChart margin={{ top: 12, right: 16, bottom: 18, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              scale="sqrt"
              domain={[0, maxGenerations]}
              ticks={GENERATION_TICKS.filter((tick) => tick <= maxGenerations)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
              tickFormatter={(value: number) => formatValue(value, 'number', null)}
              label={{ value: `Generations, last ${report.window.days} days`, position: 'insideBottom', offset: -10, fill: 'var(--muted)', fontSize: 10 }}
            />
            <YAxis
              dataKey="y"
              type="number"
              scale="sqrt"
              domain={[0, 'dataMax']}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={60}
              tickFormatter={(value: number) => money(value, true)}
            />
            <ChartTooltip content={<ScatterTooltip money={money} />} />
            <Line
              data={breakEven}
              dataKey="breakEven"
              type="monotone"
              stroke="var(--critical)"
              strokeDasharray="5 4"
              strokeWidth={1.5}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            <Scatter data={scatter} dataKey="y" isAnimationActive={false}>
              {scatter.map((row) => (
                <Cell key={row.domain} fill={row.fill} fillOpacity={0.85} />
              ))}
            </Scatter>
          </ComposedChart>
        </ChartContainer>
        <div className="mx-legend">
          <span><i style={{ background: BAND_COLOR.healthy }} />Healthy margin</span>
          <span><i style={{ background: BAND_COLOR.thin }} />Under 25% margin</span>
          <span><i style={{ background: BAND_COLOR.losing }} />Losing money</span>
          <span><i style={{ background: BAND_COLOR.unpaid }} />Not paying</span>
        </div>
      </div>

      <div className="card full">
        <div className="card-head">
          <span className="card-label">Customers by profit</span>
          <div className="funnel-views" role="group" aria-label="Filter customers">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={filter === item.key ? 'active' : undefined}
                onClick={() => {
                  setFilter(item.key);
                  setShown(PAGE);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table className="customer-table mx-table">
            <thead>
              <tr>
                <th>Shop</th>
                <th>#</th>
                <th>Status</th>
                <th>Plan</th>
                <th>Pays / mo</th>
                <th>Credits</th>
                <th>Generations</th>
                <th>Cost</th>
                <th>Profit</th>
                <th>Margin</th>
                <th>$ / gen</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((row) => (
                <tr key={row.domain}>
                  <td>
                    {row.shopId ? (
                      <a className="customer-link" href={`#/customers/${encodeURIComponent(row.shopId)}`}>
                        <span className="customer-name">{row.name ?? row.domain}</span>
                        <span className="customer-domain">{row.domain}</span>
                      </a>
                    ) : (
                      <span className="customer-link">
                        <span className="customer-name">{row.domain}</span>
                      </span>
                    )}
                  </td>
                  <td>{row.rank}</td>
                  <td>
                    <span className={`pill pill-${row.status === 'paying' ? 'paying' : row.status === 'trialing' ? 'trialing' : 'gone'}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="mx-plan" title={row.plan ?? undefined}>{row.tier ?? '—'}</td>
                  <td>
                    {money(row.paidMrr)}
                    {row.discounted ? (
                      <span className="mx-list" title="List price">
                        {' '}
                        of {money(row.listMrr)}
                      </span>
                    ) : null}
                  </td>
                  <td className={row.credits > 0 ? undefined : 'mx-list'}>
                    {row.credits > 0 ? money(row.credits) : '—'}
                  </td>
                  <td>{count(row.generations)}</td>
                  <td>{money(row.cost)}</td>
                  <td className={row.profit < 0 ? 'mx-bad' : undefined}>{money(row.profit)}</td>
                  <td className={row.margin !== null && row.margin < 0.25 ? 'mx-warn' : undefined}>{pct(row.margin)}</td>
                  <td>
                    {row.revenuePerGeneration === null ? '—' : unitMoney(row.revenuePerGeneration, report.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? <p className="footnote">Nobody in this group.</p> : null}
        {rows.length > shown ? (
          <div className="pager">
            <button type="button" onClick={() => setShown((n) => n + PAGE * 4)}>
              Show more ({count(rows.length - shown)} left)
            </button>
          </div>
        ) : null}
        <p className="footnote">
          {report.excluded > 0 ? `${count(report.excluded)} internal store(s) excluded. ` : ''}
          {usage.unmatchedDomains.length > 0
            ? `${count(usage.unmatchedDomains.length)} domain(s) with usage are not in the Partner API. `
            : ''}
          Usage through {usage.latestDay ? formatCalendarDate(usage.latestDay) : '—'}.
        </p>
      </div>

      {/* ---------------------------------------------------- the ceiling */}
      <h2 className="mx-section">Cancellation ceiling</h2>
      <p className="mx-section-blurb">
        New customers arrive at a steady rate and churn takes a steady share, so the base converges
        on <em>new per month ÷ monthly churn</em> and stalls there. Averaged over the last{' '}
        {ceiling.months} months.
      </p>

      <div className="card full mx-figures">
        <Figure label="Paying now" value={count(ceiling.overall.current)} />
        <Figure
          label="Customer ceiling"
          value={ceiling.overall.ceiling === null ? 'None' : count(ceiling.overall.ceiling)}
          note={`${pct(ceiling.overall.progress)} of the way there`}
        />
        <Figure
          label="New per month"
          value={ceiling.overall.newPerMonth.toFixed(1)}
          note={`${ceiling.overall.lostPerMonth.toFixed(1)} lost per month`}
        />
        <Figure label="Monthly churn" value={pct(ceiling.overall.churnRate, 1)} tone="bad" />
        <Figure
          label="Max MRR"
          value={ceiling.revenue.maxPaidMrr === null ? 'No ceiling' : money(ceiling.revenue.maxPaidMrr)}
          note={
            ceiling.revenue.maxMrr === null
              ? 'Expansion outpaces churn'
              : `${money(ceiling.revenue.maxMrr)} at list · ${pct(ceiling.revenue.progress)} reached`
          }
        />
      </div>

      <div className="card full">
        <div className="card-head">
          <span className="card-label">Paying customers against their ceiling</span>
        </div>
        <p className="card-subtitle">
          Each point uses the six months before it. When the two lines meet, growth stops unless
          acquisition rises or churn falls.
        </p>
        <ChartContainer
          config={{
            current: { label: 'Paying', color: 'var(--series-1)' },
            ceiling: { label: 'Ceiling', color: 'var(--series-2)' },
          }}
          className="aspect-auto w-full"
          style={{ height: 220 }}
          initialDimension={{ width: 800, height: 220 }}
        >
          <LineChart data={ceiling.history} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
              tickFormatter={(value: string) =>
                new Date(value).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
              }
            />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} />
            <ChartTooltip
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="tooltip">
                    <div className="tooltip-date">
                      {new Date(String(label)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    {payload.map((entry) => (
                      <div className="tooltip-row" key={String(entry.dataKey)}>
                        <span className="name">
                          <span className="legend-swatch" style={{ background: entry.color }} />
                          {entry.dataKey === 'ceiling' ? 'Ceiling' : 'Paying'}
                        </span>
                        <span className="value">{entry.value === null ? '—' : count(Number(entry.value))}</span>
                      </div>
                    ))}
                  </div>
                ) : null
              }
            />
            <Line type="monotone" dataKey="current" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="ceiling"
              stroke="var(--series-2)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
        <div className="mx-legend">
          <span><i style={{ background: 'var(--series-1)' }} />Paying customers</span>
          <span><i style={{ background: 'var(--series-2)' }} />Ceiling</span>
        </div>
      </div>

      <div className="card full">
        <div className="card-head">
          <span className="card-label">Ceiling by plan tier</span>
        </div>
        <p className="card-subtitle">
          Your plans are usage tiers, so moving up a tier counts here: an upgrade leaves one tier and
          joins the next. Each tier's own churn sets its own ceiling.
        </p>
        <div className="table-wrap">
          <table className="mx-table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>List price</th>
                <th>Paying</th>
                <th>New / mo</th>
                <th>Lost / mo</th>
                <th>Churn</th>
                <th>Ceiling</th>
                <th>Reached</th>
                <th>Paid MRR</th>
                <th>Gens / shop</th>
                <th>Profit / shop</th>
              </tr>
            </thead>
            <tbody>
              {ceiling.tiers.map((tier) => (
                <tr key={tier.key}>
                  <td className="mx-tier">{tier.label}</td>
                  <td>
                    {tier.priceRange
                      ? tier.priceRange[0] === tier.priceRange[1]
                        ? money(tier.priceRange[0])
                        : `${money(tier.priceRange[0], true)}–${money(tier.priceRange[1], true)}`
                      : '—'}
                  </td>
                  <td>{count(tier.current)}</td>
                  <td>{tier.newPerMonth.toFixed(1)}</td>
                  <td>{tier.lostPerMonth.toFixed(1)}</td>
                  <td>{pct(tier.churnRate, 1)}</td>
                  <td>{tier.ceiling === null ? 'None' : count(tier.ceiling)}</td>
                  <td>{pct(tier.progress)}</td>
                  <td>{money(tier.paidMrr)}</td>
                  <td>{tier.generationsPerShop === null ? '—' : count(tier.generationsPerShop)}</td>
                  <td>{tier.profitPerShop === null ? '—' : money(tier.profitPerShop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="footnote">
          Max MRR is new MRR per month ({money(ceiling.revenue.newMrrPerMonth)}) over net MRR churn (
          {pct(ceiling.revenue.netMrrChurnRate, 1)} a month: cancellations, freezes and downgrades net
          of upgrades), shown at today’s ratio of paid to list price.
        </p>
      </div>
    </div>
  );
}
