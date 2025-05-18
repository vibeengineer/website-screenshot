# api/Dockerfile
FROM node:20-slim

# 1️⃣  OS deps required by Playwright’s bundled Chromium
RUN apt-get update && apt-get install -y \
      libgl1-mesa-glx libnss3 libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2️⃣  deps & build
COPY api/package.json api/pnpm-lock.yaml ./
RUN npm i -g pnpm && pnpm install --prod
COPY api .
RUN pnpm build

ENV PORT=3000
ENV BROWSERLESS_WS=ws://browserless:3000/?token=browserless_token
EXPOSE 3000
CMD ["node", "dist/index.js"]
