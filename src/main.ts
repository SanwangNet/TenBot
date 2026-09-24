import "dotenv/config";

import { SqliteMemberRepository } from "./members/sqlite-repository.js";
import { createQqBot } from "./qq/bot.js";
import { configureMemberRepository } from "./qq/conversation/known-members.js";
import { logger } from "./shared/logger.js";

try {
    configureMemberRepository(new SqliteMemberRepository());
} catch (error) {
    logger.error("[Members] SQLite unavailable; using memory for this run", error);
}

const bot = createQqBot();
await bot.start();
