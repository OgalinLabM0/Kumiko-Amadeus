// v2.14.28 H6.a — PostCSS pipeline for the build-time Tailwind setup.
// Vite picks this up automatically. Filename uses `.cjs` because the
// project's package.json sets "type": "module" — `.js` would be parsed
// as ESM and `module.exports = {}` is not valid in that mode.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
