import { createTenBotRuntime } from "./runtime.js";

const runtime = await createTenBotRuntime({ consoleLogs: true });
await runtime.start();
