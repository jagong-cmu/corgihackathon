# Chalk — production image. Builds the app, then serves the static frontend
# AND the API from one Node server (server/prod.ts). The Anthropic key is read
# from the ANTHROPIC_API_KEY env var at runtime — never baked into the image.
FROM node:22-slim
WORKDIR /app

# Install deps first for layer caching (needs dev deps: vite/tsc build the app).
COPY package*.json ./
RUN npm ci

# Build the frontend (dist/).
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Serves dist/ + /api on one origin.
CMD ["npm", "start"]
