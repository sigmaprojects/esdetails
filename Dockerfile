# Use the official Playwright image — comes with Chromium and all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install production dependencies only
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

CMD ["node", "src/server.js"]
