FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY gateway ./gateway
EXPOSE 3090
CMD ["node", "gateway/server.mjs"]
