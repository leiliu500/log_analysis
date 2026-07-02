import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0e14',
        panel: '#12161f',
        edge: '#232a36',
      },
    },
  },
  plugins: [],
};

export default config;
