import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./auth/auth-gate.js";
import { FeedbackProvider } from "./ui/feedback.js";
import "./styles.css";
import "./design.css";
import "./motion.css";
import "./fonts.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <FeedbackProvider><AuthGate /></FeedbackProvider>
    </StrictMode>,
);
