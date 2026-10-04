/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVEKIT_SERVER_URL: string
  readonly VITE_BACKEND_URL: string
  readonly VITE_STREAM_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
