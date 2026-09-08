/**
 * Mix multiple microphone / system-audio MediaStreams into one outgoing track
 * using the Web Audio API. Cloudflare Stream live ingest accepts one A/V mix.
 */

export type ChannelId = string;

export interface MixerChannel {
  id: ChannelId;
  label: string;
  deviceId: string;
  stream: MediaStream;
  muted: boolean;
  solo: boolean;
  volume: number; // 0..1
}

interface InternalChannel extends MixerChannel {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
}

export class AudioMixer {
  private context: AudioContext;
  private destination: MediaStreamAudioDestinationNode;
  private channels = new Map<ChannelId, InternalChannel>();
  private masterGain: GainNode;
  private masterAnalyser: AnalyserNode;
  private masterData: Uint8Array<ArrayBuffer>;
  private raf: number | null = null;
  private levelListeners = new Set<(levels: Record<string, number>) => void>();

  constructor() {
    this.context = new AudioContext();
    this.destination = this.context.createMediaStreamDestination();
    this.masterGain = this.context.createGain();
    this.masterAnalyser = this.context.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.masterData = new Uint8Array(
      new ArrayBuffer(this.masterAnalyser.frequencyBinCount),
    );

    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.destination);
  }

  get mixedStream(): MediaStream {
    return this.destination.stream;
  }

  get mixedAudioTrack(): MediaStreamTrack | null {
    return this.destination.stream.getAudioTracks()[0] ?? null;
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  list(): MixerChannel[] {
    return [...this.channels.values()].map((channel) => ({
      id: channel.id,
      label: channel.label,
      deviceId: channel.deviceId,
      stream: channel.stream,
      muted: channel.muted,
      solo: channel.solo,
      volume: channel.volume,
    }));
  }

  async addDevice(deviceId: string, label: string): Promise<MixerChannel> {
    if (this.channels.has(deviceId)) {
      return this.channels.get(deviceId)!;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    await this.resume();

    const source = this.context.createMediaStreamSource(stream);
    const gain = this.context.createGain();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 256;
    const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(this.masterGain);
    gain.gain.value = 1;

    const channel: InternalChannel = {
      id: deviceId,
      label: label || "Microphone",
      deviceId,
      stream,
      muted: false,
      solo: false,
      volume: 1,
      source,
      gain,
      analyser,
      data,
    };

    this.channels.set(deviceId, channel);
    this.applyGains();
    this.ensureMeterLoop();
    return channel;
  }

  remove(id: ChannelId): void {
    const channel = this.channels.get(id);
    if (!channel) return;

    channel.source.disconnect();
    channel.gain.disconnect();
    channel.analyser.disconnect();
    channel.stream.getTracks().forEach((t) => t.stop());
    this.channels.delete(id);
    this.applyGains();
  }

  setMuted(id: ChannelId, muted: boolean): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.muted = muted;
    this.applyGains();
  }

  setSolo(id: ChannelId, solo: boolean): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.solo = solo;
    this.applyGains();
  }

  setVolume(id: ChannelId, volume: number): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.volume = Math.min(1, Math.max(0, volume));
    this.applyGains();
  }

  onLevels(listener: (levels: Record<string, number>) => void): () => void {
    this.levelListeners.add(listener);
    this.ensureMeterLoop();
    return () => {
      this.levelListeners.delete(listener);
      if (this.levelListeners.size === 0 && this.raf != null) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
    };
  }

  dispose(): void {
    [...this.channels.keys()].forEach((id) => this.remove(id));
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    void this.context.close();
  }

  private applyGains(): void {
    const anySolo = [...this.channels.values()].some((c) => c.solo);

    for (const channel of this.channels.values()) {
      const silencedBySolo = anySolo && !channel.solo;
      const effective =
        channel.muted || silencedBySolo ? 0 : channel.volume;
      channel.gain.gain.setTargetAtTime(
        effective,
        this.context.currentTime,
        0.015,
      );
    }
  }

  private ensureMeterLoop(): void {
    if (this.raf != null || this.levelListeners.size === 0) return;

    const tick = () => {
      const levels: Record<string, number> = {};

      for (const channel of this.channels.values()) {
        channel.analyser.getByteTimeDomainData(channel.data);
        levels[channel.id] = rmsFromTimeDomain(channel.data);
      }

      this.masterAnalyser.getByteTimeDomainData(this.masterData);
      levels.__mix__ = rmsFromTimeDomain(this.masterData);

      for (const listener of this.levelListeners) listener(levels);
      this.raf = requestAnimationFrame(tick);
    };

    this.raf = requestAnimationFrame(tick);
  }
}

function rmsFromTimeDomain(data: Uint8Array<ArrayBuffer>): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 3);
}

export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  // Permission prompt so labels are populated (best-effort in headless / no-device envs)
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach((t) => t.stop());
  } catch {
    // Continue — enumerateDevices may still return devices without labels.
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export async function listVideoInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ video: true });
    temp.getTracks().forEach((t) => t.stop());
  } catch {
    // Continue without camera permission / hardware.
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}
