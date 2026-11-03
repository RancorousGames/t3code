import react from "@vitejs/plugin-react";
import { moriUiLocalizationPlugin } from "./scripts/vite-ui-localization.mjs";
import { defineConfig } from "vite";

// The UI is self-contained: no T3 component imports, so no Tailwind or path aliases are needed.
export default defineConfig({
  base: "./",
  plugins: [moriUiLocalizationPlugin(), react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: "dist" },
  server: { strictPort: true },
});
