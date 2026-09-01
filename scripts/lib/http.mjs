import { setTimeout as sleep } from "node:timers/promises";
import process from "node:process";

export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);
const MAX_RETRY_AFTER_MS = 60_000;

export function githubHeaders(token, extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "qwen-studio-linux-release",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function retryAfterMs(response) {
  const header = response?.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
}

function backoffMs(attempt, baseDelayMs, maxDelayMs) {
  const window = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return window + Math.floor(Math.random() * window);
}

function describe(response, failure) {
  return response ? `HTTP ${response.status}` : `${failure?.name ?? "Error"}: ${failure?.message ?? "unknown"}`;
}

export async function fetchRetry(url, options = {}, { attempts = 4, timeoutMs = 30_000, baseDelayMs = 1_000, maxDelayMs = 15_000, retryNonIdempotent = false, onRetry } = {}) {
  if (options.signal) throw new Error("fetchRetry owns the AbortSignal; pass timeoutMs instead");
  const method = (options.method ?? "GET").toUpperCase();
  const retryable = retryNonIdempotent || IDEMPOTENT_METHODS.has(method);
  for (let attempt = 1; ; attempt += 1) {
    let response = null;
    let failure = null;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      failure = error;
    }
    if (response && !RETRYABLE_STATUS.has(response.status)) return response;
    if (!retryable || attempt >= attempts) {
      if (failure) throw failure;
      return response;
    }
    const delay = retryAfterMs(response) ?? backoffMs(attempt, baseDelayMs, maxDelayMs);
    if (response?.body) await response.body.cancel().catch(() => {});
    const report = onRetry ?? ((event) => process.stderr.write(`retrying ${method} ${event.url} after ${describe(event.response, event.failure)} (attempt ${event.attempt}/${attempts}, waiting ${event.delayMs}ms)\n`));
    report({ attempt, attempts, url: String(url), method, response, failure, delayMs: delay });
    await sleep(delay);
  }
}
