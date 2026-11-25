FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /data/uploads && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
CMD ["npm", "run", "start"]