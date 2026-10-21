FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
RUN npm ci --workspace @rufa/server --include-workspace-root=false
COPY apps/server ./apps/server
RUN npm run build --workspace @rufa/server
RUN npm prune --omit=dev --workspace @rufa/server --include-workspace-root=false

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/migrations ./apps/server/migrations
USER node
EXPOSE 8787
CMD ["node", "apps/server/dist/main.js"]
