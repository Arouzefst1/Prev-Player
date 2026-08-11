/** @type {import('tailwindcss').Config} */
export default {
  // Every file that can contain a class name. Scanned at build time, which is what
  // replaces the Play CDN's runtime DOM scanning.
  content: ['./index.html', './*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
