# 构建上下文 = 仓库根目录（Railway 服务变量 RAILWAY_DOCKERFILE_PATH=service/Dockerfile 指向本文件）
FROM node:24-slim

# git：实例仓库读写与同步；ssh：用 deploy key 推送私库。引擎不执行实例里的任何脚本，所以不装 python。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY service/package.json service/package-lock.json ./
RUN npm ci --omit=dev
COPY service/src ./src
COPY service/templates ./templates
COPY service/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production NODE_NO_WARNINGS=1
CMD ["./docker-entrypoint.sh"]
