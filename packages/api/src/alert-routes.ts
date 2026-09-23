import type { FastifyInstance } from 'fastify';
import type { PiPulseDb } from '@pipulse/storage';
import { acknowledgeAlert, type Alert, type Rule, type RuleSource } from '@pipulse/alerts';

export interface AlertRulesOptions {
  /** The rule layers; saving and removing go through it. */
  source: RuleSource;
  /** Runs an alert check now, so a saved change shows without waiting up to 15 s. */
  recheck?: () => void;
}

/** Messages the API itself pushes to /api/live clients. */
export type Notice =
  { type: 'rules'; rules: Rule[] } | { type: 'alert'; event: 'acknowledged'; alert: Alert };

const RULE_ID = /^[a-z][a-z0-9_]*$/;
/** A rule is a few hundred bytes; this leaves room for a long message. */
const RULE_BODY_LIMIT = 4096;

/**
 * Rule editing and acknowledging. Auth is decided by the one hook in
 * auth-routes.ts (every PUT, DELETE and POST here needs a session). The body
 * schema is deliberately only { type: 'object' }: Fastify strips properties
 * a stricter schema doesn't list, and an unknown field must be an error the
 * operator sees, which parseRuleEntry reports with its name.
 */
export function registerAlertRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: { rules?: AlertRulesOptions; publish(notice: Notice): void; now?: () => number }
): void {
  const now = options.now ?? Date.now;

  app.post<{ Params: { id: number } }>(
    '/api/alerts/:id/acknowledge',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } }
        }
      }
    },
    async (request, reply) => {
      const result = acknowledgeAlert(db, request.params.id, now());
      if (result === 'not_found') return reply.status(404).send({ error: 'no such alert' });
      if (result === 'cleared') {
        return reply.status(409).send({ error: 'this alert has already cleared' });
      }
      options.publish({ type: 'alert', event: 'acknowledged', alert: result });
      return result;
    }
  );

  const rules = options.rules;
  if (!rules) return;

  const changed = () => {
    rules.recheck?.();
    const { rules: inForce, entries } = rules.source.read();
    options.publish({ type: 'rules', rules: inForce });
    return { rules: entries };
  };

  app.get('/api/alerts/rules', async () => ({ rules: rules.source.read().entries }));

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/alerts/rules/:id',
    { bodyLimit: RULE_BODY_LIMIT, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      const { id } = request.params;
      if (!RULE_ID.test(id)) {
        return reply.status(400).send({ errors: { id: 'id must be lowercase snake_case' } });
      }
      if (request.body['id'] !== undefined && request.body['id'] !== id) {
        return reply.status(400).send({ errors: { id: 'id must match the rule being saved' } });
      }
      const result = rules.source.save({ ...request.body, id }, now());
      if (!result.ok) return reply.status(400).send({ errors: result.errors });
      return changed();
    }
  );

  app.delete<{ Params: { id: string } }>('/api/alerts/rules/:id', async (request, reply) => {
    if (!rules.source.remove(request.params.id, now())) {
      return reply.status(404).send({ error: 'nothing is saved for this rule' });
    }
    return changed();
  });
}
