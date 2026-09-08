/**
 * Lazy loader for the Cloudflare Stream player SDK so the viewer can mute the
 * iframe player locally (the iframe is cross-origin, so we cannot poke the
 * <video> inside it directly).
 */

export interface StreamPlayerApi {
  muted: boolean;
  volume: number;
  play(): Promise<void> | void;
  pause(): void;
}

type StreamFactory = (element: HTMLIFrameElement) => StreamPlayerApi;

declare global {
  interface Window {
    Stream?: StreamFactory;
  }
}

const SDK_URL = "https://embed.cloudflarestream.com/embed/sdk.latest.js";
let loading: Promise<StreamFactory> | null = null;

export function loadStreamPlayerSdk(): Promise<StreamFactory> {
  if (window.Stream) return Promise.resolve(window.Stream);
  if (loading) return loading;

  loading = new Promise<StreamFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.Stream) resolve(window.Stream);
      else reject(new Error("Stream SDK loaded but window.Stream is missing"));
    };
    script.onerror = () => reject(new Error("Could not load the Stream player SDK"));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    loading = null;
    throw err;
  });

  return loading;
}
