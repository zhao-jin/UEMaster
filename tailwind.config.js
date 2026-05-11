/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0A0E1A",
          panel: "rgba(16, 22, 38, 0.72)",
          row: "rgba(255, 255, 255, 0.03)",
          rowHover: "rgba(0, 229, 255, 0.06)",
        },
        accent: {
          cyan: "#00E5FF",
          cyanDim: "#00B8D4",
          purple: "#7C4DFF",
          green: "#00E676",
          orange: "#FF9100",
          red: "#FF3D71",
        },
        text: {
          primary: "#E6EDF7",
          secondary: "#8B95AB",
          dim: "#5A6479",
        },
        border: {
          subtle: "rgba(255, 255, 255, 0.06)",
          glow: "rgba(0, 229, 255, 0.35)",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 20px rgba(0, 229, 255, 0.25)",
        glowSm: "0 0 8px rgba(0, 229, 255, 0.4)",
        panel: "0 8px 32px rgba(0, 0, 0, 0.5)",
      },
      animation: {
        "pulse-glow": "pulseGlow 2s ease-in-out infinite",
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        pulseGlow: {
          "0%, 100%": { opacity: "0.6", filter: "drop-shadow(0 0 4px #00E5FF)" },
          "50%": { opacity: "1", filter: "drop-shadow(0 0 12px #00E5FF)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
