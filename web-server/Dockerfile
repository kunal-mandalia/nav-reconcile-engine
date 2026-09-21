FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web-app/package.json web-app/package.json
COPY web-server/package.json web-server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY web-server web-server
RUN npm run build -w web-server

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY web-app/package.json web-app/package.json
COPY web-server/package.json web-server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --workspace=web-server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/web-server/dist web-server/dist
ENV HOST=0.0.0.0 PORT=4000 NODE_ENV=development
USER node
EXPOSE 4000
CMD ["node", "web-server/dist/index.js"]
