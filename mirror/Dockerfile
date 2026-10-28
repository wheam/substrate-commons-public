# 构建上下文 = mirror/ 目录（railway up mirror --path-as-root）
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
ENV NODE_ENV=production NODE_NO_WARNINGS=1
EXPOSE 8080
CMD ["node", "src/server.js"]
