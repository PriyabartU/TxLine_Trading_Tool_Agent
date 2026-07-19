// Oracle League frontend — standalone static server, fully independent of the
// backend API process. Deployable separately (Vercel/Netlify/nginx: just ship
// the public/ folder; this server is for local dev and simple hosting).
import express from "express";
import path from "path";

const WEB_PORT = Number(process.env.WEB_PORT ?? 8080);
const app = express();
app.use(express.static(path.join(import.meta.dirname, "..", "public")));
app.listen(WEB_PORT, () => {
  console.log(`🖥  Oracle League frontend at http://localhost:${WEB_PORT}  (expects API on :3000)`);
});
