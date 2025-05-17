FROM node:20-slim

WORKDIR /app

# Install Chromium dependencies (just in case we need them locally)
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install --prod

# Copy source files
COPY . .

# Build TypeScript code
RUN pnpm build

EXPOSE 3000

CMD ["node", "dist/index.js"]