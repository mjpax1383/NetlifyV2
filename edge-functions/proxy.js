const getEnv = (key) => {
  try {
    if (globalThis.Netlify?.env?.get) {
      return globalThis.Netlify.env.get(key);
    }
  } catch (_) {}

  try {
    return Deno.env.get(key);
  } catch (_) {
    return undefined;
  }
};

function parseBackend(raw) {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  try {
    if (value.includes("://")) {
      return new URL(value);
    }
    return new URL(`https://${value}`);
  } catch (_) {
    return null;
  }
}

const BACKEND = parseBackend(getEnv("BACKEND_URL"));
const UPSTREAM_TIMEOUT_MS = Number(getEnv("UPSTREAM_TIMEOUT_MS") || "25000");
const DEBUG_PROXY = getEnv("DEBUG_PROXY") === "1";

if (!BACKEND) {
  console.warn("[proxy] BACKEND_URL is missing or invalid");
}

const BACKEND_BASE_PATH = BACKEND?.pathname && BACKEND.pathname !== "/"
  ? BACKEND.pathname.replace(/\/$/, "")
  : "";

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "keep-alive",
  "host",
  "content-length",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-nf-client-connection-ip",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "upgrade",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

function stripHeaders(headers, blocked) {
  const cleaned = new Headers(headers);
  for (const key of blocked) {
    cleaned.delete(key);
  }
  return cleaned;
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener(
        "abort",
        () => controller.abort(signal.reason),
        { once: true },
      );
    }
  }

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

export default async (request) => {
  if (!BACKEND) {
    return new Response("BACKEND_URL missing or invalid", { status: 500 });
  }

  const incomingURL = new URL(request.url);
  const upstreamURL = new URL(incomingURL.toString());
  upstreamURL.protocol = BACKEND.protocol || "https:";
  upstreamURL.hostname = BACKEND.hostname;
  upstreamURL.port = BACKEND.port;
  if (BACKEND_BASE_PATH) {
    upstreamURL.pathname = `${BACKEND_BASE_PATH}${incomingURL.pathname}`;
  }

  const headers = stripHeaders(request.headers, HOP_BY_HOP_REQUEST_HEADERS);

  const clientIp =
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  if (clientIp) {
    headers.set("x-forwarded-for", clientIp);
    headers.set("x-real-ip", clientIp);
  }

  const method = request.method.toUpperCase();
  const shouldHaveBody = method !== "GET" && method !== "HEAD";

  const timeout = withTimeout(request.signal, UPSTREAM_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(upstreamURL, {
      method: request.method,
      headers,
      body: shouldHaveBody ? request.body : undefined,
      redirect: "manual",
      signal: timeout.signal,
    });

    const responseHeaders = stripHeaders(
      upstreamResponse.headers,
      HOP_BY_HOP_RESPONSE_HEADERS,
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const status = error?.name === "AbortError" ? 504 : 502;
    const baseMessage = error?.name === "AbortError"
      ? "Gateway Timeout"
      : "Bad Gateway";

    if (DEBUG_PROXY) {
      const detail = error?.message ? `: ${error.message}` : "";
      return new Response(`${baseMessage}${detail}`, { status });
    }

    return new Response(baseMessage, { status });
  } finally {
    timeout.clear();
  }
};
