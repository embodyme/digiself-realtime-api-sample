/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OUTPUT_WEBSOCKET_URL: string
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
