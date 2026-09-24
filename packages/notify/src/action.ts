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
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  // Undici also refuses to dial the Fetch spec's "bad port" list (e.g. 1) before ever
  // reaching the network; from a webhook's point of view that's as unreachable as a
  // real ECONNREFUSED, so it gets the same short reason.
  if (cause?.code === 'ECONNREFUSED' || cause?.message === 'bad port') return 'connection refused';
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
        response = await fetchImpl(webhook.url, {
          method: webhook.method,
          headers: { ...webhook.headers, 'content-type': 'application/json' },
          body: payload,
          redirect: 'manual',
          signal
        });
      } catch (error) {
        throw new Error(reasonOf(error, signal), { cause: error });
      }
      try {
        await drain(response);
      } catch {
        // The status is what matters; a broken body after it doesn't change it.
      }
      if (response.status >= 300 && response.status < 400)
        throw new Error(`redirect (HTTP ${response.status})`);
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP ${response.status}`);
    }
  };
}
