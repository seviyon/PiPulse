import type { FastifyInstance } from 'fastify';
import {
  diskFreeBytes,
  estimateBytes,
  policyOf,
  previewDeletion,
  RESOLUTIONS,
  saveRetention,
  storageUsage,
  validateRetention,
  type LookBack,
  type PiPulseDb,
  type Resolution,
  type RetentionLevel,
  type RetentionSettings
} from '@pipulse/storage';
import { durationText, type Rule } from '@pipulse/alerts';

export interface SettingsOptions {
  getRetention: () => RetentionSettings;
  /**
   * Raw retention may not be shorter than the longest look-back of the
   * alert rules in force, read on every check (rules can change in the
   * browser).
   */
  rawAtLeast?: () => LookBack | undefined;
  /** What is collected, for the size estimate. */
  metrics: { intervalMs: number }[];
  /** Free bytes on the database's disk; defaults to statfs on its directory. */
  diskFree?: () => number | undefined;
  now?: () => number;
}

/** The rule whose `for` or `clearAfter` reaches furthest back into raw readings. */
export function longestLookBack(rules: Rule[]): LookBack | undefined {
  let longest: LookBack | undefined;
  for (const rule of rules) {
    const ms = Math.max(rule.forMs, rule.clearAfterMs);
    if (ms > 0 && (!longest || ms > longest.ms)) {
      longest = { ms, ruleId: rule.id, text: durationText(ms) };
    }
  }
  return longest;
}

/**
 * Why the raw retention in force can't serve the alert rules (they read raw
 * readings only), naming where the value came from, or undefined when it
 * can. A value saved on the Settings page gets a way to start anyway, since
 * the page itself is unreachable while startup fails.
 */
export function rawRetentionProblem(
  raw: RetentionLevel,
  lookBack: LookBack | undefined
): string | undefined {
  if (!lookBack || raw.ms >= lookBack.ms) return undefined;
  const rule = `rule "${lookBack.ruleId}" looks back (${lookBack.text})`;
  if (raw.source === 'env') {
    return `${raw.variable} (${raw.text}) is shorter than ${rule}; lengthen it or shorten the rule`;
  }
  const where =
    raw.source === 'saved'
      ? 'raw retention saved on the Settings page'
      : 'the default raw retention';
  return (
    `${where} (${raw.text}) is shorter than ${rule}; ` +
    `start with ${raw.variable}=${lookBack.text} (or longer) and change it on the Settings page, or shorten the rule`
  );
}

const retentionSchema = {
  type: 'object',
  properties: Object.fromEntries(
    RESOLUTIONS.map((resolution) => [resolution, { type: 'string', maxLength: 32 }])
  ),
  additionalProperties: false
};

const previewSchema = {
  type: 'object',
  required: ['retention'],
  properties: { retention: retentionSchema },
  additionalProperties: false
};

const saveSchema = {
  type: 'object',
  required: ['retention'],
  properties: { retention: retentionSchema, confirmDeletion: { type: 'boolean' } },
  additionalProperties: false
};

type Proposal = Partial<Record<Resolution, string>>;

export function registerSettingsRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: SettingsOptions
): void {
  const now = options.now ?? Date.now;
  const diskFree = options.diskFree ?? (() => diskFreeBytes(db));

  const body = () => {
    const levels = options.getRetention();
    const retention = Object.fromEntries(
      RESOLUTIONS.map((resolution) => {
        const level = levels[resolution];
        return [
          resolution,
          {
            text: level.text,
            ms: Number.isFinite(level.ms) ? level.ms : null,
            source: level.source,
            variable: level.variable,
            locked: level.source === 'env'
          }
        ];
      })
    );
    return {
      retention,
      storage: { ...storageUsage(db), diskFreeBytes: diskFree() ?? null }
    };
  };

  /** Validation and preview shared by preview and save. */
  const check = (proposal: Proposal) => {
    const result = validateRetention(proposal, options.getRetention(), options.rawAtLeast?.());
    if (!result.ok) return { ok: false as const, errors: result.errors };
    const policy = policyOf(result.levels);
    return {
      ok: true as const,
      levels: result.levels,
      preview: {
        deletions: previewDeletion(db, policy, policyOf(options.getRetention()), now()),
        estimatedBytes: estimateBytes(policy, options.metrics, storageUsage(db))
      }
    };
  };

  app.get('/api/settings', async () => body());

  app.post<{ Body: { retention: Proposal } }>(
    '/api/settings/preview',
    { schema: { body: previewSchema } },
    async (request, reply) => {
      const result = check(request.body.retention);
      if (!result.ok) return reply.status(400).send({ errors: result.errors });
      return result.preview;
    }
  );

  app.put<{ Body: { retention: Proposal; confirmDeletion?: boolean } }>(
    '/api/settings',
    { schema: { body: saveSchema } },
    async (request, reply) => {
      const result = check(request.body.retention);
      if (!result.ok) return reply.status(400).send({ errors: result.errors });
      const deletes = RESOLUTIONS.some((r) => result.preview.deletions[r].deletesRows > 0);
      if (deletes && request.body.confirmDeletion !== true) {
        return reply
          .status(409)
          .send({ error: 'this change deletes data; confirm it first', ...result.preview });
      }
      saveRetention(db, result.levels, now());
      return body();
    }
  );
}
