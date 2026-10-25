/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          bg: "#1a1410",
          card: "#2a241c",
          border: "#3d342a",
        },
        accent: {
          gold: "#d4af37",
          muted: "#9d8860",
        },
        text: {
          primary: "#f5f0e8",
          secondary: "#c9bfb0",
        },
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
