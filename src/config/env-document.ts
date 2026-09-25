import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { parse as parseDotenv } from "dotenv";

export function parseEnvDocument(content: string): Record<string, string> {
    return parseDotenv(content);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function encodeValue(value: string): string {
    return /\s|[#'"`]/.test(value) ? JSON.stringify(value) : value;
}

function replaceValue(line: string, key: string, value: string): string | undefined {
    const match = line.match(new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*)(.*)$`));
    if (!match) return undefined;
    const suffix = match[2].match(/\s+#.*$/)?.[0] ?? "";
    return `${match[1]}${encodeValue(value)}${suffix}`;
}

export function patchEnvDocument(content: string, patches: Readonly<Record<string, string>>): string {
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    const hasTrailingNewline = content.endsWith("\n");
    const lines = content ? content.split(/\r?\n/) : [];
    if (hasTrailingNewline) lines.pop();

    const missing: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(patches)) {
        let replaced = false;
        for (let index = 0; index < lines.length; index++) {
            const next = replaceValue(lines[index] ?? "", key, value);
            if (next === undefined) continue;
            lines[index] = next;
            replaced = true;
        }
        if (!replaced) missing.push([key, value]);
    }
    for (const [key, value] of missing) lines.push(`${key}=${encodeValue(value)}`);

    let result = lines.join(newline);
    if (hasTrailingNewline) result += newline;
    return result;
}

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        let mode: number | undefined;
        try { mode = (await stat(filePath)).mode; } catch { /* New files use the platform default mode. */ }
        await writeFile(temporaryPath, content, "utf8");
        if (mode !== undefined) await chmod(temporaryPath, mode);
        await rename(temporaryPath, filePath);
    } finally {
        try { await unlink(temporaryPath); } catch { /* The rename already removed it. */ }
    }
}

export async function readEnvDocument(filePath: string): Promise<string> {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        if (isMissingFile(error)) return "";
        throw error;
    }
}

export function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
