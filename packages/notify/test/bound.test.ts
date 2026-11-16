import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, raiseAlert } from '@pipulse/alerts';
import { DeliveryError, type AlertAction } from '../src/action.js';
import { compact, PENDING_CAP } from '../src/compact.js';
import type { WebhookConfig } from '../src/config.js';
import { createEnqueuer } from '../src/enqueue.js';
import { shiftPending } from '../src/outbox.js';
import { GIVE_UP_AFTER_MS, sendDue } from '../src/sender.js';
import { getState } from '../src/state.js';

const MIN = 60_000;
/** Distinct (rule, metric) pairs the simulation raises alerts for. */
const PAIRS = 5;

/** A small seeded generator, so a failing run can be replayed from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Shape = WebhookConfig['events'];
const SHAPES: Shape[] = [['raised', 'cleared'], ['raised'], ['cleared']];

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

interface Row {
  id: number;
  event: string;
  status: string;
  alertId: number;
  startedAt: number | null;
}
const alertRows = () =>
  db
    .prepare(
      `SELECT id, event, status, alert_id AS alertId, started_at AS startedAt FROM notifications
       WHERE webhook_id = 'w' AND event IN ('raised', 'cleared') ORDER BY id`
    )
    .all() as unknown as Row[];
const pendingCount = () => alertRows().filter((r) => r.status === 'pending').length;

/** Runs one seeded simulation and checks the invariants after every step. */
function simulate(seed: number, events: Shape, steps: number) {
  const seen = { overCap: 0, keptClearMax: 0 };
  const random = mulberry32(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  let wall = 1_000_000_000_000;
  const webhook: WebhookConfig = {
    id: 'w',
    url: 'http://x',
    method: 'POST',
    headers: {},
    events,
    minSeverity: 'warning',
    timeoutMs: 1000
  };
  const context = () => ({ now: wall, hostname: 'Io', metrics: [] });
  const enqueue = createEnqueuer(db, {
    webhooks: [webhook],
    hostname: 'Io',
    metrics: [],
    now: () => wall
  });
  const open = new Map<number, number>(); // pair → alert id

  let outcome: 'ok' | 'http' | 'transport' | 'permanent' = 'ok';
  const action: AlertAction = {
    id: 'w',
    apiVersion: 1,
    async deliver() {
      if (outcome === 'ok') return;
      if (outcome === 'permanent')
        throw new DeliveryError('HTTP 401', { kind: 'permanent', transport: false });
      throw new DeliveryError(outcome === 'http' ? 'HTTP 503' : 'timeout', {
        kind: 'retryable',
        transport: outcome === 'transport'
      });
    }
  };

  const toggle = (pair: number) => {
    const id = open.get(pair);
    if (id === undefined) {
      const alert = raiseAlert(db, {
        ruleId: `r${pair}`,
        metric: `m${pair}`,
        severity: 'warning',
        message: 'x',
        value: 1,
        raisedAt: wall
      });
      open.set(pair, alert.id);
      enqueue({ type: 'raised', alert });
    } else {
      open.delete(pair);
      enqueue({ type: 'cleared', alert: clearAlert(db, id, wall, 'condition') });
    }
  };

  const checkPrefix = (label: string) => {
    let sawPending = false;
    for (const row of alertRows()) {
      if (row.status === 'pending') sawPending = true;
      else
        expect(
          sawPending,
          `${label}: a ${row.status} row follows a pending one (seed ${seed})`
        ).toBe(false);
    }
  };

  // The sender runs compaction before an attempt while the webhook is degraded or over the cap.
  const prepare = (label: string) => {
    const before = pendingCount();
    if (getState(db, 'w').degradedSince === null && before <= PENDING_CAP) return;
    if (before > PENDING_CAP) seen.overCap++;
    compact(db, webhook, context());
    const after = pendingCount();
    expect(after, `${label}: compaction grew the queue (seed ${seed})`).toBeLessThanOrEqual(before);
    if (before > PENDING_CAP)
      expect(
        after,
        `${label}: over the cap, more than 2P+3 remain (seed ${seed})`
      ).toBeLessThanOrEqual(2 * PAIRS + 3);
    else expect(after, `${label}: above the cap (seed ${seed})`).toBeLessThanOrEqual(PENDING_CAP);
    // Clears kept for a started raise are at most one per pair.
    const rows = alertRows();
    const startedRaises = new Set(
      rows.filter((r) => r.event === 'raised' && r.startedAt !== null).map((r) => r.alertId)
    );
    const keptClears = rows.filter(
      (r) => r.status === 'pending' && r.event === 'cleared' && startedRaises.has(r.alertId)
    );
    seen.keptClearMax = Math.max(seen.keptClearMax, keptClears.length);
    expect(
      keptClears.length,
      `${label}: more kept clears than pairs (seed ${seed})`
    ).toBeLessThanOrEqual(PAIRS);
  };

  return (async () => {
    let outage = 0;
    for (let step = 0; step < steps; step++) {
      const kind = pick([
        'raise',
        'raise',
        'raise',
        'clear',
        'clear',
        'clear',
        'time',
        'send',
        'send',
        'burst',
        'jump',
        'exhaust'
      ]);
      const label = `step ${step} (${kind})`;
      if (kind === 'raise' || kind === 'clear') toggle(Math.floor(random() * PAIRS));
      else if (kind === 'burst') for (let i = 0; i < 120; i++) toggle(Math.floor(random() * PAIRS));
      else if (kind === 'time') wall += pick([1_000, 30_000, 3 * MIN, 10 * MIN, 2 * 60 * MIN]);
      else if (kind === 'jump') {
        const jump = pick([-3, -1, 1, 3]) * 60 * MIN;
        wall += jump;
        shiftPending(db, jump);
      } else if (kind === 'exhaust') {
        wall += GIVE_UP_AFTER_MS + MIN;
        outcome = 'http';
        for (let i = 0; i < 3; i++) {
          prepare(label);
          await sendDue(db, [{ action, timeoutMs: 50 }], { now: () => wall });
        }
      } else {
        if (outage === 0 && random() < 0.3) outage = 2 + Math.floor(random() * 6);
        for (let i = 0; i < 3; i++) {
          outcome =
            outage > 0 ? pick(['http', 'transport', 'permanent']) : random() < 0.1 ? 'http' : 'ok';
          prepare(label);
          wall += 5 * MIN;
          await sendDue(db, [{ action, timeoutMs: 50 }], { now: () => wall });
        }
        if (outage > 0) outage--;
      }
      checkPrefix(label);
    }
    return { ...seen, counts: getState(db, 'w').counts };
  })();
}

describe('the queue bound and the completed-prefix invariant', () => {
  for (const events of SHAPES) {
    it(`holds across random outages, rejections, exhaustion, bursts and clock jumps (${events.join('+')})`, async () => {
      let overCap = 0;
      let keptClearMax = 0;
      const counts = { rejected: 0, abandoned: 0, dropped: 0, opened_and_cleared: 0, cleared: 0 };
      for (let seed = 1; seed <= 12; seed++) {
        db.close();
        db = openDb(':memory:');
        const result = await simulate(seed, events, 250);
        overCap += result.overCap;
        keptClearMax = Math.max(keptClearMax, result.keptClearMax);
        for (const key of Object.keys(counts) as (keyof typeof counts)[])
          counts[key] += result.counts[key];
      }
      // The runs must reach the cases the bound is about, or passing proves nothing.
      expect(overCap).toBeGreaterThan(0);
      expect(counts.rejected).toBeGreaterThan(0);
      expect(counts.abandoned).toBeGreaterThan(0);
      expect(counts.opened_and_cleared + counts.cleared + counts.dropped).toBeGreaterThan(0);
      if (events.includes('raised') && events.includes('cleared'))
        expect(keptClearMax).toBeGreaterThan(0);
    }, 60_000);
  }
});
