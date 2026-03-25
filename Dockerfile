# Use the official Playwright image — comes with Chromium and all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000

CMD ["node", "src/server.js"]
