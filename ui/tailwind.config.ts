import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Soft sunrise palette
        cream: '#FDF6EE',
        card: '#FFFDFA',
        ink: {
          DEFAULT: '#52404F',
          soft: '#8A7385',
          faint: '#B5A3B1',
        },
        rose: {
          DEFAULT: '#E2687A',
          deep: '#C94F62',
          soft: '#F9E0E4',
          whisper: '#FDF0F2',
        },
        peach: {
          DEFAULT: '#F5A97F',
          soft: '#FFE8D6',
        },
        lavender: {
          DEFAULT: '#A48FCB',
          soft: '#E6DFF5',
        },
        sage: {
          DEFAULT: '#7FA97F',
          soft: '#E4EFE0',
        },
        honey: {
          DEFAULT: '#E0A458',
          soft: '#FAEDD8',
        },
      },
      fontFamily: {
        display: ['"Fraunces Variable"', 'Georgia', 'serif'],
        body: ['"Nunito Variable"', 'ui-rounded', 'sans-serif'],
      },
      boxShadow: {
        cozy: '0 4px 24px -6px rgba(201, 79, 98, 0.14), 0 2px 8px -4px rgba(82, 64, 79, 0.08)',
        'cozy-lg': '0 12px 40px -8px rgba(201, 79, 98, 0.18), 0 4px 12px -4px rgba(82, 64, 79, 0.10)',
        lifted: '0 2px 6px -2px rgba(82, 64, 79, 0.12)',
      },
      borderRadius: {
        cozy: '1.25rem',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'gentle-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        breathe: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.06)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
        'gentle-pulse': 'gentle-pulse 2.4s ease-in-out infinite',
        breathe: 'breathe 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
