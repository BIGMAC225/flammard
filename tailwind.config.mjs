/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#08080c',
          surface: '#0f1015',
          elevated: '#1a1b23',
          input: '#13141c',
        },
        accent: {
          DEFAULT: '#7b6cf6',
          dim: '#5a4de0',
          muted: 'rgba(123, 108, 246, 0.12)',
          ring: 'rgba(123, 108, 246, 0.35)',
        },
        ink: {
          primary: '#f0f0f5',
          secondary: '#8a8b9a',
          muted: '#4a4b60',
          invert: '#0a0a0f',
        },
        line: {
          DEFAULT: 'rgba(255,255,255,0.06)',
          strong: 'rgba(255,255,255,0.10)',
        },
        state: {
          success: '#22c55e',
          warning: '#f59e0b',
          danger: '#ef4444',
          info: '#60a5fa',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease',
        'slide-up': 'slideUp 0.3s ease',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
};
