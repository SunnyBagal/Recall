import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// NOTE: React Compiler was previously configured as react({ babel: {...} }),
// which @vitejs/plugin-react v6 no longer accepts — its Options type has no
// `babel` key since the plugin moved to oxc. That broke `tsc -b`, so
// `npm run build` failed outright and no frontend deploy could succeed.
//
// To re-enable React Compiler, install the two peer deps and pass the preset
// through the Rolldown babel plugin instead:
//   npm i -D @rolldown/plugin-babel babel-plugin-react-compiler
//   import babel from '@rolldown/plugin-babel'
//   plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()]
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
})
