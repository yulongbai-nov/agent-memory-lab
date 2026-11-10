# The published official DSH CLI; version check is mandatory at image build.
FROM node:24.12.0-bookworm-slim
WORKDIR /opt/dsh-test
RUN npm install --omit=dev --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.2-rc.1 \
 && test "$(./node_modules/.bin/dsh --version)" = "0.2.2-rc.1"
COPY run.cjs mock-session.cjs recall.cjs provider.patch.yml memory.patch.yml recall.patch.yml recall-provider.patch.yml ./
RUN mkdir -p /out /archive /memory && chown node:node /out /archive /memory
ENV NODE_ENV=production
USER node
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/dsh-test/mock-session.cjs"]
