import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on IPv4 + IPv6 so localhost works regardless of resolution
    port: Number(process.env.WEB_PORT ?? 8080),
  },
});
