// Next uses PostCSS rather than the Vite plugin, so Tailwind 4 loads here.
const config = {
  plugins: { '@tailwindcss/postcss': {} },
};

export default config;
