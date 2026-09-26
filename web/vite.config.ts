import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: webRoot,
    plugins: [react()],
    server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:3000",
                changeOrigin: false,
            },
        },
    },
    build: {
        outDir: resolve(webRoot, "dist"),
        emptyOutDir: true,
    },
});
