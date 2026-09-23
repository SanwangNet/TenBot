import "dotenv/config";

import { createQqBot } from "./qq/bot.js";
import { loadKnownMembers } from "./qq/conversation/known-members.js";

await loadKnownMembers();

const bot = createQqBot();
await bot.start();
