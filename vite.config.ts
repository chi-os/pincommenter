import { defineConfig } from "vite";
import { devvit } from "@devvit/start/vite";

export default defineConfig({
  plugins: [
    // Das Devvit Plugin kümmert sich um das korrekte Bündeln nach dist/server/index.cjs
    devvit(),
  ],
});