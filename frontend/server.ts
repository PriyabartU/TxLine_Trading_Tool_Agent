// Sealed League frontend — standalone static server, fully independent of the
// backend API process. Serves the Vite build output (run `npm run build` first).
// For local development use `npm run dev` (Vite dev server with hot reload).
import express from "express";
import path from "path";

const WEB_PORT = Number(process.env.WEB_PORT ?? 8080);
const app = express();
const dist = path.join(import.meta.dirname, "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
app.listen(WEB_PORT, () => {
  console.log(`🖥  Sealed League frontend at http://localhost:${WEB_PORT}  (expects API on :3000)`);
});
