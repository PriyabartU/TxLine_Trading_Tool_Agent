/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public URL of the API service (hosted builds); unset for local dev. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
