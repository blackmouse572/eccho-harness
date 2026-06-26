import { defineConfig } from "@flue/cli/config";
import { defineConfig as defineViteConfig } from "vite";

export default defineConfig({
  target: "cloudflare",
});

export const vite = defineViteConfig({
  server: {
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "ditch-film-backing.ngrok-free.dev",
    ],
  },
});
