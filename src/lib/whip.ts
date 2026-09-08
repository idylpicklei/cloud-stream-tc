/** Minimal WHIP client for Cloudflare Stream live WebRTC publish. */

export interface WhipSession {
  pc: RTCPeerConnection;
  sessionUrl: string;
  localStream: MediaStream;
}

async function negotiate(
  pc: RTCPeerConnection,
  url: string,
): Promise<string> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait briefly for ICE gathering when trickle isn't used in the basic flow.
  await waitForIceGathering(pc, 1500);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription?.sdp ?? offer.sdp,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `WHIP publish failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  const answer = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("WHIP response missing Location header");
  }
  return new URL(location, url).toString();
}

function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(done, timeoutMs);
  });
}

export async function startWhipBroadcast(
  whipUrl: string,
  media: MediaStream,
): Promise<WhipSession> {
  const pc = new RTCPeerConnection({
    bundlePolicy: "max-bundle",
  });

  for (const track of media.getTracks()) {
    pc.addTransceiver(track, { direction: "sendonly" });
  }

  const sessionUrl = await negotiate(pc, whipUrl);
  return { pc, sessionUrl, localStream: media };
}

export async function stopWhipBroadcast(session: WhipSession | null): Promise<void> {
  if (!session) return;

  try {
    if (session.sessionUrl) {
      await fetch(session.sessionUrl, { method: "DELETE" });
    }
  } catch {
    // Best-effort hangup
  }

  session.pc.close();
  // Do not stop media tracks — the host studio keeps camera/mixer for the next go-live.
}
