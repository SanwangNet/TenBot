export function splitDisplayPath(path: string): { fileName: string; directory: string } {
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    const fileName = parts.at(-1) ?? path;
    const directory = parts.slice(0, -1).join("/") || ".";
    return { fileName, directory };
}
