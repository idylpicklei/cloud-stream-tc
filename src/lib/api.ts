export interface ViewerConfig {
  liveInputUid: string | null;
  customerCode: string | null;
  playerUrl: string | null;
  whepUrl: string | null;
  status: string;
  name: string;
  note?: string;
  needsSetup?: boolean;
  message?: string;
}

export interface HostSession extends ViewerConfig {
  whipUrl: string | null;
  created?: boolean;
  message?: string;
  needsLiveInput?: boolean;
}

export interface HealthStatus {
  ok: boolean;
  hasAccountId: boolean;
  hasStreamToken: boolean;
  hasHostToken: boolean;
  hasCustomerCode: boolean;
  hasLiveInputUid: boolean;
}

function hostHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch("/api/health");
  return readJson<HealthStatus>(res);
}

export async function fetchViewerConfig(): Promise<ViewerConfig> {
  const res = await fetch("/api/viewer");
  return readJson<ViewerConfig>(res);
}

export async function pingHost(token: string): Promise<{ ok: boolean }> {
  const res = await fetch("/api/host/ping", {
    headers: hostHeaders(token),
  });
  return readJson<{ ok: boolean }>(res);
}

export async function fetchHostSession(token: string): Promise<HostSession> {
  const res = await fetch("/api/host/session", {
    headers: hostHeaders(token),
  });
  return readJson<HostSession>(res);
}

export async function createLiveInput(
  token: string,
  name?: string,
  forceNew = false,
): Promise<HostSession> {
  const res = await fetch("/api/host/live-input", {
    method: "POST",
    headers: hostHeaders(token),
    body: JSON.stringify({ name, forceNew }),
  });
  return readJson<HostSession>(res);
}
