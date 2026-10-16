import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Shown in the online panel so we can tell which version each player is running.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')) },
  server: { open: true },
});
