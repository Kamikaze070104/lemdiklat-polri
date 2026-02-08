import path from "path";
import { defineConfig, loadEnv } from "vite";
import dotenv from "dotenv";

// Load .env file
dotenv.config();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    base: './', // Important for Electron relative paths
    define: {
      // Expose GEMINI_API_KEY dari .env via define
      "process.env.GEMINI_API_KEY": JSON.stringify(
        env.GEMINI_API_KEY || process.env.GEMINI_API_KEY
      ),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        }
      }
    }
  };
});
