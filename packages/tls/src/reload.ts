import { CLASS_RANK, type LoadedCertificate } from './inspect.js';

export interface ReloadState {
  state: 'ok' | 'failing';
  /** Unix ms of the last attempt to load a replacement, if any. */
  lastAttempt: number | null;
  lastError: string | null;
}

export interface CertificateProvider {
  /** The certificate being served. */
  current(): LoadedCertificate;
  reload(): ReloadState;
  /** One poll (the timer calls this every pollMs). */
  poll(): void;
  stop(): void;
}

const HOUR_MS = 60 * 60_000;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Watches the active source's files and swaps in a replacement without a
 * restart. A change must look the same on two polls (so a certificate copied
 * a moment before its key is never tried alone); the candidate goes through
 * the full startup checks (`load` throws on refused material); it is applied
 * only if its class is at least as good as the active one's. Anything else
 * keeps the active certificate and reports 'failing'. `stat` polling rather
 * than fs.watch: atomic rename-over and bind mounts make watch events unreliable.
 */
export function startReloader(options: {
  initial: LoadedCertificate;
  load: () => LoadedCertificate;
  signature: () => string;
  apply: (cert: LoadedCertificate) => void;
  /**
   * Extra rules a candidate must pass (throw to refuse): the caller's
   * startup validity policy, so a reload never activates what startup would refuse.
   */
  accept?: (candidate: LoadedCertificate, active: LoadedCertificate) => void;
  /**
   * The files' signature as read BEFORE the caller loaded `initial`, so a
   * change landing during startup is still seen. Omitted: read now.
   */
  initialSignature?: string;
  pollMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** false: no timer, the caller drives poll() (tests). */
  timer?: boolean;
}): CertificateProvider {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let active = options.initial;
  let activeSignature = options.initialSignature ?? options.signature();
  let pending: string | undefined;
  const state: ReloadState = { state: 'ok', lastAttempt: null, lastError: null };
  let lastLogged: { message: string; at: number } | undefined;

  const fail = (message: string) => {
    state.state = 'failing';
    state.lastError = message;
    const t = now();
    if (!lastLogged || lastLogged.message !== message || t - lastLogged.at >= HOUR_MS) {
      log(`HTTPS certificate not reloaded: ${message}`);
      lastLogged = { message, at: t };
    }
  };

  const attempt = () => {
    state.lastAttempt = now();
    let candidate: LoadedCertificate;
    try {
      candidate = options.load();
    } catch (error) {
      fail(messageOf(error));
      return;
    }
    if (candidate.fingerprint === active.fingerprint) {
      state.state = 'ok';
      state.lastError = null;
      return;
    }
    if (CLASS_RANK[candidate.class] < CLASS_RANK[active.class]) {
      fail(
        `the replacement is ${candidate.class} and the active certificate is ${active.class}; kept the active one`
      );
      return;
    }
    try {
      options.accept?.(candidate, active);
      options.apply(candidate);
    } catch (error) {
      fail(messageOf(error));
      return;
    }
    active = candidate;
    state.state = 'ok';
    state.lastError = null;
    lastLogged = undefined;
    log(`HTTPS certificate reloaded (SHA-256 ${candidate.fingerprint})`);
  };

  const poll = () => {
    const signature = options.signature();
    if (signature === activeSignature) {
      pending = undefined;
      return;
    }
    if (signature !== pending) {
      pending = signature;
      return;
    }
    // Seen unchanged twice: try it once, whatever the outcome.
    activeSignature = signature;
    pending = undefined;
    attempt();
  };

  const timer = options.timer === false ? undefined : setInterval(poll, options.pollMs ?? 60_000);
  timer?.unref();

  return {
    current: () => active,
    reload: () => ({ ...state }),
    poll,
    stop: () => {
      if (timer) clearInterval(timer);
    }
  };
}
