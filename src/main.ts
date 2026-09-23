import "dotenv/config";

import { createQqBot } from "./qq/bot.js";

const bot = createQqBot();
await bot.start();
