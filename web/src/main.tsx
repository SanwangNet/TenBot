import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { RuntimeProvider } from "./runtime/runtime-context.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <RuntimeProvider>
            <App />
        </RuntimeProvider>
    </StrictMode>,
);
