/** Minimal WHEP client for Cloudflare Stream live WebRTC playback. */

export interface WhepSession {
  pc: RTCPeerConnection;
  sessionUrl: string;
  remoteStream: MediaStream;
}

async function negotiate(
  pc: RTCPeerConnection,
  url: string,
): Promise<string> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await waitForIceGathering(pc, 1500);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription?.sdp ?? offer.sdp,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `WHEP play failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  const answer = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("WHEP response missing Location header");
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

export async function startWhepPlayback(whepUrl: string): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const remoteStream = new MediaStream();
  pc.ontrack = (event) => {
    remoteStream.addTrack(event.track);
  };

  const sessionUrl = await negotiate(pc, whepUrl);
  return { pc, sessionUrl, remoteStream };
}

export async function stopWhepPlayback(session: WhepSession | null): Promise<void> {
  if (!session) return;

  try {
    if (session.sessionUrl) {
      await fetch(session.sessionUrl, { method: "DELETE" });
    }
  } catch {
    // Best-effort hangup
  }

  session.pc.close();
}
