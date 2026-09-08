/**
 * ClassStream Worker API
 *
 * Protects Stream credentials and hands the host a WHIP publish URL.
 * Viewer endpoints stay public and never expose the WHIP secret.
 */

export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  STREAM_API_TOKEN: string;
  HOST_TOKEN: string;
  /** Your Stream customer subdomain code, e.g. "abc123xyz" from customer-<CODE>.cloudflarestream.com */
  STREAM_CUSTOMER_CODE: string;
  /** Optional: reuse a live input created in the dashboard or via API */
  STREAM_LIVE_INPUT_UID?: string;
}

interface LiveInputResponse {
  uid: string;
  status?: {
    current?: {
      state?: string;
      statusDate?: string;
    };
  } | null;
  webRTC?: { url?: string };
  webRTCPlayback?: { url?: string };
  meta?: { name?: string };
  recording?: { mode?: string };
}

interface CloudflareApiResult<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function unauthorized(message = "Host token required"): Response {
  return json({ error: message }, 401);
}

function requireHost(request: Request, env: Env): Response | null {
  if (!env.HOST_TOKEN) {
    return json(
      {
        error:
          "HOST_TOKEN is not configured. Set it in .dev.vars (local) or wrangler secret (deploy).",
      },
      500,
    );
  }

  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : (request.headers.get("X-Host-Token") ?? "").trim();

  if (!token || token !== env.HOST_TOKEN) {
    return unauthorized("Invalid or missing host token");
  }
  return null;
}

function streamApiBase(env: Env): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream`;
}

async function streamFetch<T>(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.STREAM_API_TOKEN) {
    return {
      ok: false,
      status: 500,
      message:
        "CLOUDFLARE_ACCOUNT_ID and STREAM_API_TOKEN must be set (see README).",
    };
  }

  const response = await fetch(`${streamApiBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json()) as CloudflareApiResult<T>;
  if (!response.ok || !body.success || !body.result) {
    const message =
      body.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
      `Stream API error (${response.status})`;
    return { ok: false, status: response.status, message };
  }

  return { ok: true, data: body.result };
}

function publicViewerPayload(input: LiveInputResponse, env: Env) {
  const customerCode = env.STREAM_CUSTOMER_CODE?.trim();
  const playerUrl = customerCode
    ? `https://customer-${customerCode}.cloudflarestream.com/${input.uid}/iframe`
    : null;

  return {
    liveInputUid: input.uid,
    customerCode: customerCode || null,
    playerUrl,
    whepUrl: input.webRTCPlayback?.url ?? null,
    status: input.status?.current?.state ?? "idle",
    name: input.meta?.name ?? "Class stream",
    note:
      "This app broadcasts with WHIP (browser WebRTC). Viewers should use WHEP or the Stream player (auto-upgrades to WHEP). HLS recording is not available for WHIP inputs yet.",
  };
}

async function resolveLiveInput(
  env: Env,
  options: { createIfMissing?: boolean; name?: string } = {},
): Promise<
  | { ok: true; input: LiveInputResponse; created: boolean }
  | { ok: false; status: number; message: string }
> {
  const configuredUid = env.STREAM_LIVE_INPUT_UID?.trim();

  if (configuredUid) {
    const result = await streamFetch<LiveInputResponse>(
      env,
      `/live_inputs/${configuredUid}`,
    );
    if (!result.ok) return result;
    return { ok: true, input: result.data, created: false };
  }

  if (!options.createIfMissing) {
    return {
      ok: false,
      status: 400,
      message:
        "STREAM_LIVE_INPUT_UID is not set. Create a live input in the Cloudflare dashboard (Stream → Live inputs) or call POST /api/host/live-input, then set the UID in env.",
    };
  }

  const created = await streamFetch<LiveInputResponse>(env, "/live_inputs", {
    method: "POST",
    body: JSON.stringify({
      meta: { name: options.name ?? "ClassStream classroom" },
      recording: { mode: "off" },
    }),
  });

  if (!created.ok) return created;
  return { ok: true, input: created.data, created: true };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 404 });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          hasAccountId: Boolean(env.CLOUDFLARE_ACCOUNT_ID),
          hasStreamToken: Boolean(env.STREAM_API_TOKEN),
          hasHostToken: Boolean(env.HOST_TOKEN),
          hasCustomerCode: Boolean(env.STREAM_CUSTOMER_CODE?.trim()),
          hasLiveInputUid: Boolean(env.STREAM_LIVE_INPUT_UID?.trim()),
        });
      }

      if (url.pathname === "/api/viewer" && request.method === "GET") {
        const resolved = await resolveLiveInput(env);
        if (!resolved.ok) {
          return json({ error: resolved.message }, resolved.status);
        }
        return json(publicViewerPayload(resolved.input, env));
      }

      if (url.pathname === "/api/host/session" && request.method === "GET") {
        const gate = requireHost(request, env);
        if (gate) return gate;

        const resolved = await resolveLiveInput(env);
        if (!resolved.ok) {
          return json({ error: resolved.message }, resolved.status);
        }

        const whipUrl = resolved.input.webRTC?.url;
        if (!whipUrl) {
          return json(
            {
              error:
                "Live input is missing webRTC.url (WHIP). Confirm Stream Live WebRTC is available on your account.",
            },
            500,
          );
        }

        return json({
          ...publicViewerPayload(resolved.input, env),
          whipUrl,
          created: resolved.created,
        });
      }

      if (url.pathname === "/api/host/live-input" && request.method === "POST") {
        const gate = requireHost(request, env);
        if (gate) return gate;

        const body = (await request.json().catch(() => ({}))) as {
          name?: string;
          forceNew?: boolean;
        };

        if (env.STREAM_LIVE_INPUT_UID?.trim() && !body.forceNew) {
          const existing = await resolveLiveInput(env);
          if (!existing.ok) {
            return json({ error: existing.message }, existing.status);
          }
          return json({
            ...publicViewerPayload(existing.input, env),
            whipUrl: existing.input.webRTC?.url ?? null,
            created: false,
            message:
              "Using STREAM_LIVE_INPUT_UID from env. Pass { \"forceNew\": true } to create another input (you must update env to use it).",
          });
        }

        const created = await streamFetch<LiveInputResponse>(env, "/live_inputs", {
          method: "POST",
          body: JSON.stringify({
            meta: { name: body.name ?? "ClassStream classroom" },
            recording: { mode: "off" },
          }),
        });

        if (!created.ok) {
          return json({ error: created.message }, created.status);
        }

        return json({
          ...publicViewerPayload(created.data, env),
          whipUrl: created.data.webRTC?.url ?? null,
          created: true,
          message:
            "Live input created. Copy uid into STREAM_LIVE_INPUT_UID (wrangler vars / dashboard) so host and viewer stay in sync.",
        });
      }

      if (url.pathname === "/api/host/status" && request.method === "GET") {
        const gate = requireHost(request, env);
        if (gate) return gate;

        const resolved = await resolveLiveInput(env);
        if (!resolved.ok) {
          return json({ error: resolved.message }, resolved.status);
        }

        return json(publicViewerPayload(resolved.input, env));
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return json({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
