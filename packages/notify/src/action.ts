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
        // eslint-disable-next-line preserve-caught-error -- raw undici errors can carry the URL and header values
        throw new Error(reasonOf(error, signal));
      }
      try {
        await drain(response);
      } catch {
        // The status is what matters; a broken body after it doesn't change it.
      }
      // A 2xx status counts as delivered even if the body then stalls or breaks (deliberate).
      if (response.status >= 300 && response.status < 400)
        throw new Error(`redirect (HTTP ${response.status})`);
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP ${response.status}`);
    }
  };
}
