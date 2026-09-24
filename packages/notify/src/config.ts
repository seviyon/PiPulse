import { readFileSync, statSync } from 'node:fs';
import { parseDuration } from '@pipulse/storage';
import { checkTemplate, TemplateError } from './template.js';

export interface WebhookConfig {
  id: string;
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: unknown;
  events: ('raised' | 'cleared')[];
  minSeverity: 'warning' | 'critical';
  timeoutMs: number;
}

export interface NotifyFile {
  name: string;
  text: string;
  worldReadable: boolean;
}

/** A problem with the notify file; its message is one line meant for the operator. */
export class NotifyConfigError extends Error {}

/** Reads PIPULSE_NOTIFY_FILE; a missing or unreadable file is a NotifyConfigError. */
export function readNotifyFile(path: string): NotifyFile {
  try {
    const text = readFileSync(path, 'utf8');
    const worldReadable = (statSync(path).mode & 0o077) !== 0;
    return { name: path, text, worldReadable };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new NotifyConfigError(`PIPULSE_NOTIFY_FILE ${path} could not be read: ${code}`);
  }
}

/** "host:port" (or just "host"), with any credentials, path and query stripped. */
export function urlHost(url: string): string {
  return new URL(url).host;
}

const FIELDS = new Set([
  'id',
  'url',
  'method',
  'headers',
  'body',
  'events',
  'minSeverity',
  'timeout'
]);
const EVENTS = ['raised', 'cleared'] as const;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function parseWebhook(raw: unknown, where: string): WebhookConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NotifyConfigError(`${where}: must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const label = typeof r['id'] === 'string' ? ` ("${r['id']}")` : '';
  const fail: (problem: string) => never = (problem) => {
    throw new NotifyConfigError(`${where}${label}: ${problem}`);
  };
  for (const key of Object.keys(r)) if (!FIELDS.has(key)) fail(`unknown field "${key}"`);

  const id = r['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id))
    fail('id must be lowercase snake_case');

  const url = r['url'];
  if (typeof url !== 'string') fail('url must be an http:// or https:// URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url as string);
  } catch {
    fail('url must be an http:// or https:// URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
    fail('url must be an http:// or https:// URL');

  const methodRaw = r['method'];
  if (methodRaw !== undefined && methodRaw !== 'POST' && methodRaw !== 'PUT')
    fail('method must be POST or PUT');
  const method = (methodRaw ?? 'POST') as 'POST' | 'PUT';

  const headersRaw = r['headers'];
  let headers: Record<string, string> = {};
  if (headersRaw !== undefined) {
    if (
      typeof headersRaw !== 'object' ||
      headersRaw === null ||
      Array.isArray(headersRaw) ||
      Object.values(headersRaw as Record<string, unknown>).some((v) => typeof v !== 'string')
    ) {
      fail('headers must map names to strings');
    }
    headers = headersRaw as Record<string, string>;
  }

  const eventsRaw = r['events'];
  let events: ('raised' | 'cleared')[] = [...EVENTS];
  if (eventsRaw !== undefined) {
    if (
      !Array.isArray(eventsRaw) ||
      eventsRaw.length === 0 ||
      eventsRaw.some((e) => !(EVENTS as readonly string[]).includes(e))
    ) {
      fail(`events must be a non-empty list of ${EVENTS.join(', ')}`);
    }
    events = eventsRaw as ('raised' | 'cleared')[];
  }

  const minSeverityRaw = r['minSeverity'];
  if (
    minSeverityRaw !== undefined &&
    minSeverityRaw !== 'warning' &&
    minSeverityRaw !== 'critical'
  ) {
    fail('minSeverity must be warning or critical');
  }
  const minSeverity = (minSeverityRaw ?? 'warning') as 'warning' | 'critical';

  const timeoutRaw = r['timeout'];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== 'string') fail('timeout must be a duration string like "30s"');
    let ms: number;
    try {
      ms = parseDuration('timeout', timeoutRaw);
    } catch (error) {
      fail((error as Error).message);
    }
    if (!(ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS)) fail('timeout must be between 1s and 60s');
    timeoutMs = ms;
  }

  const body = r['body'];
  if (body !== undefined) {
    try {
      checkTemplate(body);
    } catch (error) {
      if (error instanceof TemplateError) fail(`body: ${error.message}`);
      throw error;
    }
  }

  const webhook: WebhookConfig = {
    id,
    url: url as string,
    method,
    headers,
    events,
    minSeverity,
    timeoutMs
  };
  if (body !== undefined) webhook.body = body;
  return webhook;
}

/** Parses PIPULSE_NOTIFY_FILE's contents into webhooks, or throws NotifyConfigError. */
export function parseNotifyConfig(file: { name: string; text: string }): WebhookConfig[] {
  let json: unknown;
  try {
    json = JSON.parse(file.text);
  } catch (error) {
    throw new NotifyConfigError(`${file.name} is not valid JSON: ${(error as Error).message}`);
  }
  const list =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as { webhooks?: unknown }).webhooks
      : undefined;
  if (!Array.isArray(list))
    throw new NotifyConfigError(`${file.name} must be an object with a "webhooks" array`);
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const webhook = parseWebhook(raw, `${file.name} webhooks[${i}]`);
    if (seen.has(webhook.id))
      throw new NotifyConfigError(`${file.name}: webhook id "${webhook.id}" appears twice`);
    seen.add(webhook.id);
    return webhook;
  });
}
