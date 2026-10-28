import { defineConfig } from 'vite';
import { aiPlugin } from './server/ai';

export default defineConfig({
  plugins: [aiPlugin()],
});
