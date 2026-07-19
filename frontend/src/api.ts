// Frontend and API run as separate services. Hosted builds set VITE_API_BASE
// to the API's public URL (baked in at build time). Locally: if this page is
// served from the API port itself, use same-origin; otherwise target :3000.
export const API_BASE =
  import.meta.env.VITE_API_BASE?.replace(/\/$/, "") ??
  (location.port === "3000" ? "" : `${location.protocol}//${location.hostname}:3000`);
