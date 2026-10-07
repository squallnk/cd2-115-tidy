FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存；--ignore-scripts 跳过 protobufjs 的 postinstall（非必需）
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-fund --no-audit \
 && npm cache clean --force

COPY src ./src
COPY protos ./protos

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    ROOT_PATH=/115/4 \
    PAD=4

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.mjs"]
