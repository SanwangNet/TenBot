import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { RuntimeProvider } from "./runtime/runtime-context.js";
import { FeedbackProvider } from "./ui/feedback.js";
import "./styles.css";
import "./design.css";
import "./motion.css";
import "./fonts.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <FeedbackProvider><RuntimeProvider><App /></RuntimeProvider></FeedbackProvider>
    </StrictMode>,
);
