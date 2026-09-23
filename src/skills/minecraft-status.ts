import mc from "minecraftstatuspinger";

const SERVER_HOST = "39.107.105.23";
const SERVER_PORT = 25565;

export const minecraftStatusTool = {
    type: "function" as const,
    name: "minecraft_status",
    description:
        "查询 Minecraft 服务器当前状态。当用户询问服务器是否在线、服务器熟了吗、有没有人、在线人数、延迟、版本等信息时调用。",
    parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
    },
};

export interface MinecraftStatusResult {
    online: boolean;
    host: string;
    port: number;
    latencyMs?: number;
    playersOnline?: number;
    playersMax?: number;
    version?: string;
    error?: string;
}

export async function runMinecraftStatus(): Promise<MinecraftStatusResult> {
    try {
        const result = await mc.lookup({
            host: SERVER_HOST,
            port: SERVER_PORT,
            ping: true,
            timeout: 5000,
            SRVLookup: false,
        });

        const status = result.status as {
            players?: {
                online?: number;
                max?: number;
            };
            version?: {
                name?: string;
            };
        } | null;

        return {
            online: true,
            host: SERVER_HOST,
            port: SERVER_PORT,
            latencyMs:
                typeof result.latency === "number"
                    ? Math.round(result.latency)
                    : undefined,
            playersOnline: status?.players?.online,
            playersMax: status?.players?.max,
            version: status?.version?.name,
        };
    } catch (error) {
        return {
            online: false,
            host: SERVER_HOST,
            port: SERVER_PORT,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}