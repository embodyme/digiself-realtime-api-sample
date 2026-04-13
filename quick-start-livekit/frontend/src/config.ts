export const LIVEKIT_SERVER_URL = import.meta.env.VITE_LIVEKIT_SERVER_URL;
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;
export const STREAM_API_URL = import.meta.env.VITE_STREAM_API_URL;

if (!LIVEKIT_SERVER_URL || !BACKEND_URL || !STREAM_API_URL) {
  throw new Error("Required environment variables not set. Please check your .env file.");
}
