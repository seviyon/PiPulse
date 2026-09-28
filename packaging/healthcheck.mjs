// Docker HEALTHCHECK: exit 0 when /api/health answers 200 (the slim image has no curl).
const port = process.env.PIPULSE_PORT ?? '8888';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(4000)
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
