// Frontend and API run on separate ports. If this page is served from the API
// port itself, use same-origin; otherwise target the API on :3000.
export const API_BASE =
  location.port === "3000" ? "" : `${location.protocol}//${location.hostname}:3000`;
