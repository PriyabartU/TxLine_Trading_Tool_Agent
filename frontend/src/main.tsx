import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SolanaProviders } from "./solana/WalletCtx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
    </SolanaProviders>
  </StrictMode>,
);
