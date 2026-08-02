FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3080 DATA_DIR=/app/data
EXPOSE 3080
VOLUME ["/app/data"]
CMD ["node", "server.mjs"]
