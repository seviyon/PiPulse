import type { WebhookConfig } from './config.js';

export const ALERT_ACTION_API_VERSION = 1;

/**
 * One way of telling someone about an alert. The outbox and sender know only
 * this interface; an action owns its destination, timeout and error wording.
 * Versioned on its own, like CollectorPlugin.
 */
export interface AlertAction {
  id: string;
  apiVersion: 1;
  /** Sends one rendered notification; resolves on success, rejects with an Error whose message is a short reason. */
  deliver(payload: string, signal: AbortSignal): Promise<void>;
}

const MAX_RESPONSE_BYTES = 1024;

/** The longest a Retry-After can defer the next try (the sender applies it). */
export const MAX_RETRY_AFTER_MS = 15 * 60_000;

export type FailureKind = 'permanent' | 'retryable';

/**
 * A delivery that failed, and how to treat it. Anything an action rejects with that is
 * not a DeliveryError is read as a retryable transport failure.
 */
export class DeliveryError extends Error {
  readonly kind: FailureKind;
  /** True when no HTTP answer came back (timeout, refused, DNS, TLS). */
  readonly transport: boolean;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    options: { kind: FailureKind; transport: boolean; retryAfterMs?: number | null }
  ) {
    super(message);
    this.name = 'DeliveryError';
    this.kind = options.kind;
    this.transport = options.transport;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Permanent: 3xx and 4xx except 408, 425, 429. Retryable: those three and 5xx. */
export function classifyStatus(status: number): 'ok' | FailureKind {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 408 || status === 425 || status === 429) return 'retryable';
  if (status >= 300 && status < 500) return 'permanent';
  return 'retryable';
}

/** Retry-After as milliseconds (whole seconds or an HTTP date); null when absent, past or not usable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null;
  }
  // Anything else must be a date written with a month or weekday name: Date.parse reads
  // plain numbers such as '2099' or '1.5' as years and months.
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) || at <= nowMs ? null : at - nowMs;
}

/** Reads at most 1 KB of a response, so a huge or endless body can't hold the sender. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let read = 0;
  while (read < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) return;
    read += value.byteLength;
  }
  await reader.cancel();
}

function reasonOf(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) return 'timeout';
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNREFUSED') return 'connection refused';
  return `network error (${cause?.code ?? 'unknown'})`;
}

export function createWebhookAction(
  webhook: WebhookConfig,
  fetchImpl: typeof fetch = fetch
): AlertAction {
  return {
    id: webhook.id,
    apiVersion: 1,
    async deliver(payload, signal) {
      let response: Response;
      try {
        // Built inside the try: an invalid header value (e.g. a newline) makes the
        // Headers constructor itself throw, with that raw value in its own message.
        const headers = new Headers(webhook.headers);
        headers.set('content-type', 'application/json');
        response = await fetchImpl(webhook.url, {
          method: webhook.method,
          headers,
          body: payload,
          redirect: 'manual',
          signal
        });
      } catch (error) {
        // Not `{ cause: error }`: the raw undici error can carry the URL (credentials,
        // path, query) or a header value verbatim, and util.inspect prints it whole.
        throw new DeliveryError(reasonOf(error, signal), { kind: 'retryable', transport: true });
      }
      try {
        await drain(response);
      } catch {
        // The status is what matters; a broken body after it doesn't change it.
      }
      // A 2xx status counts as delivered even if the body then stalls or breaks (deliberate).
      const outcome = classifyStatus(response.status);
      if (outcome === 'ok') return;
      const message =
        response.status >= 300 && response.status < 400
          ? `redirect (HTTP ${response.status})`
          : `HTTP ${response.status}`;
      const retryAfterMs =
        response.status === 429 || response.status === 503
          ? parseRetryAfter(response.headers.get('retry-after'), Date.now())
          : null;
      throw new DeliveryError(message, { kind: outcome, transport: false, retryAfterMs });
    }
  };
}
