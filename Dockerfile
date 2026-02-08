# Dockerfile untuk LEMDIKLATAI - Live Audio Intelligence
# Menggunakan Node.js saja tanpa Nginx

# Stage 1: Build stage
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY bun.lock ./

# Install ALL dependencies (termasuk devDependencies untuk Vite build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
ARG GEMINI_API_KEY
ENV GEMINI_API_KEY=$GEMINI_API_KEY
RUN npm run build

# Stage 2: Production stage
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files untuk production dependencies
COPY package*.json ./

# Install hanya production dependencies
RUN npm ci --only=production

# Copy built files dari builder stage
COPY --from=builder /app/dist ./dist

# Copy source files yang dibutuhkan untuk server
COPY index.html ./
COPY ai-prompt.ts ./
COPY analyser.ts ./
COPY audio-waveform.ts ./
COPY backdrop-shader.ts ./
COPY sphere-shader.ts ./
COPY utils.ts ./
COPY visual-3d.ts ./
COPY visual.ts ./
COPY tsconfig.json ./
COPY vite.config.ts ./

# Install tsx agar bisa menjalankan TypeScript server di production
RUN npm install -g tsx

# Copy server code
COPY server ./server

# Set NODE_ENV production
ENV NODE_ENV=production

# Expose port 3000 (sesuai server.ts saat production)
EXPOSE 3000

# Jalankan Express server yang juga melayani static dist
CMD ["tsx", "server/server.ts"]