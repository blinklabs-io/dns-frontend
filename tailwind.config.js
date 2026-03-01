/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Exo 2"', "sans-serif"],
        "ibm-plex": ['"IBM Plex Sans"', "sans-serif"],
      },
    },
  },
  plugins: [],
}
