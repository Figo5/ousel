/**
 * Vite configuration for the Ousel browser client.
 *
 * Deliberate choices:
 *  - No `@vitejs/plugin-react` dependency: .tsx files are transformed by Vite's
 *    built-in esbuild pipeline with `jsx: 'automatic'`. Adding the plugin later
 *    enables Fast Refresh but is not required to build or run the app.
 *  - The client is served by the Ousel server on the same origin, so the build
 *    output is written to `dist/ui` for the server to serve.
 *  - `npm run dev` proxies /api to the local server. The server validates Host and
 *    Origin on every request, so the proxy rewrites Host (changeOrigin) and strips
 *    the dev-server Origin header; without that, the server would correctly reject
 *    the request as cross-origin.
 */
import { defineConfig } from "vite";

const apiTarget =
  process.env["OUSEL_API_URL"] ??
  process.env["AGENTOPS_API_URL"] ??
  "http://127.0.0.1:4317";

export default defineConfig({
  root: ".",
  esbuild: {
    jsx: "automatic",
    target: "es2022",
  },
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Both of the server's surfaces: the UI reads /api, and the Reply
      // button posts to /ingest like any other agent would.
      "^/(api|ingest)": {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            // The local server rejects a foreign Origin on every request.
            const origin = proxyRequest.getHeader("origin");
            if (
              origin === "http://127.0.0.1:5173" ||
              origin === "http://localhost:5173"
            )
              proxyRequest.removeHeader("origin");
            proxyRequest.removeHeader("referer");
          });
        },
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
