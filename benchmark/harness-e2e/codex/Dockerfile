FROM node:24.12.0-bookworm-slim
RUN npm install --prefix /opt/codex --ignore-scripts --no-audit --no-fund @openai/codex@0.165.0 \
 && /opt/codex/node_modules/.bin/codex --version | grep -Fx 'codex-cli 0.165.0'
ENV PATH="/opt/codex/node_modules/.bin:${PATH}"
RUN mkdir /out /memory /archive && chmod 700 /archive
WORKDIR /work
COPY mock-session.cjs recall.cjs find-contract.cjs read-contract.cjs /opt/
ENTRYPOINT ["node", "/opt/mock-session.cjs"]
