# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (including dev) for the build
COPY package*.json ./
RUN npm ci

# Compile TypeScript -> dist
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies to slim down node_modules for the runtime image
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the non-root user that ships with the node image
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

# No ports exposed on purpose — the bot only makes outbound calls
# (Telegram long polling + the listing sites). Nothing to EXPOSE.
CMD ["node", "dist/main.js"]
