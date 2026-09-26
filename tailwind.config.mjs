/** @type {import('tailwindcss').Config} */

// ── Brand ramps (shared with the firm's tax-advisor app) ─────────────────────
// Brand blue #005696 at blue-600, brand green #1FB25A at mint-500, and a warm
// "paper" neutral ramp instead of cool greys.
const blue = {
  50: '#f0f6fb',
  100: '#dcebf7',
  200: '#b6d6ef',
  300: '#85bbe4',
  400: '#4a98d1',
  500: '#1f74b3',
  600: '#005696',
  700: '#004a80',
  800: '#003a66',
  900: '#002b4d',
  950: '#001a30',
};

const mint = {
  50: '#effbf3',
  100: '#def6e6',
  200: '#b9ebcb',
  300: '#7fd9a1',
  400: '#43c579',
  500: '#1fb25a',
  600: '#189649',
  700: '#127a3b',
  800: '#0e5f2f',
  900: '#0a4623',
  950: '#052b15',
};

const warm = {
  50: '#faf9f7',
  100: '#f4f2ee',
  200: '#e8e5df',
  300: '#d6d2c9',
  400: '#a8a39a',
  500: '#7d786f',
  600: '#5f5a52',
  700: '#47433c',
  800: '#2f2c27',
  900: '#1e1c18',
  950: '#141310',
};

export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        blue,
        mint,
        warm,
        gray: warm,
        slate: warm,

        // Semantic tokens used throughout the app. The names date from the
        // original dark theme; the values are now the warm editorial palette.
        bg: {
          base: '#f8f6f1', // paper
          surface: '#ffffff', // cards
          elevated: '#f2efe9', // muted panels, hover rows
          input: '#ffffff',
        },
        accent: {
          DEFAULT: blue[600],
          dim: blue[700],
          muted: 'rgba(0, 86, 150, 0.08)',
          ring: 'rgba(0, 86, 150, 0.30)',
        },
        ink: {
          primary: warm[900],
          secondary: warm[600],
          muted: warm[500],
          invert: '#ffffff',
        },
        line: {
          DEFAULT: warm[200],
          strong: warm[300],
        },
        state: {
          success: mint[700],
          warning: '#b45309',
          danger: '#dc2626',
          info: blue[600],
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        display: ['Fraunces', 'Georgia', '"Times New Roman"', 'serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(20, 16, 10, 0.04), 0 2px 8px -2px rgba(20, 16, 10, 0.06)',
        card: '0 1px 2px rgba(20, 16, 10, 0.04), 0 6px 20px -6px rgba(20, 16, 10, 0.10)',
        lift: '0 12px 40px -10px rgba(20, 16, 10, 0.22), 0 2px 6px rgba(20, 16, 10, 0.06)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease',
        'slide-up': 'slideUp 0.3s ease',
        'fade-up': 'fadeUp 0.35s ease-out both',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        fadeUp: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
};
