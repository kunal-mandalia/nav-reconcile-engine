FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web-app/package.json web-app/package.json
COPY web-server/package.json web-server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY web-app web-app
RUN npm run build -w web-app

FROM nginx:1.28-alpine
COPY web-app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web-app/dist /usr/share/nginx/html
EXPOSE 80
